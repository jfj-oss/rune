// fakeptr: REAL pointer events into a (private, headless) KWin through its fake-input protocol, driven by lines on stdin:
//   move X Y | down | up | click X Y | dblclick X Y | drag X1 Y1 X2 Y2 | sleep MS | quit
// Coordinates are KWin output coordinates. Needs KWIN_WAYLAND_NO_PERMISSION_CHECKS=1 in the compositor (the private test KWin has it).
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <wayland-client.h>
#include "fake-input-client-protocol.h"
static struct org_kde_kwin_fake_input *fi;
static void reg(void *d, struct wl_registry *r, uint32_t name, const char *iface, uint32_t ver) {
    if (!strcmp(iface, "org_kde_kwin_fake_input")) fi = wl_registry_bind(r, name, &org_kde_kwin_fake_input_interface, ver < 5 ? ver : 5);
}
static void unreg(void *d, struct wl_registry *r, uint32_t n) {}
static const struct wl_registry_listener rl = { reg, unreg };
static struct wl_display *dpy;
static void flush(void) { wl_display_flush(dpy); wl_display_roundtrip(dpy); }
static void mv(double x, double y) { org_kde_kwin_fake_input_pointer_motion_absolute(fi, wl_fixed_from_double(x), wl_fixed_from_double(y)); flush(); }
static void btn(int down) { org_kde_kwin_fake_input_button(fi, 0x110, down); flush(); }
int main(void) {
    dpy = wl_display_connect(NULL);
    if (!dpy) { fprintf(stderr, "fakeptr: no wayland display\n"); return 1; }
    struct wl_registry *r = wl_display_get_registry(dpy);
    wl_registry_add_listener(r, &rl, NULL);
    wl_display_roundtrip(dpy);
    if (!fi) { fprintf(stderr, "fakeptr: compositor has no org_kde_kwin_fake_input\n"); return 2; }
    org_kde_kwin_fake_input_authenticate(fi, "fakeptr", "e2e test");
    flush();
    char line[256];
    setvbuf(stdout, NULL, _IOLBF, 0);
    while (fgets(line, sizeof line, stdin)) {
        double a, b, c, d; int ms;
        if (sscanf(line, "move %lf %lf", &a, &b) == 2) mv(a, b);
        else if (!strncmp(line, "down", 4)) btn(1);
        else if (!strncmp(line, "up", 2)) btn(0);
        else if (sscanf(line, "click %lf %lf", &a, &b) == 2) { mv(a, b); usleep(60000); btn(1); usleep(40000); btn(0); }
        else if (sscanf(line, "dblclick %lf %lf", &a, &b) == 2) { mv(a, b); usleep(60000); btn(1); usleep(30000); btn(0); usleep(60000); btn(1); usleep(30000); btn(0); }
        else if (sscanf(line, "drag %lf %lf %lf %lf", &a, &b, &c, &d) == 4) {
            mv(a, b); usleep(80000); btn(1); usleep(80000);
            for (int i = 1; i <= 12; i++) { mv(a + (c - a) * i / 12, b + (d - b) * i / 12); usleep(30000); }
            usleep(80000); btn(0);
        }
        else if (sscanf(line, "sleep %d", &ms) == 1) usleep(ms * 1000);
        else if (!strncmp(line, "quit", 4)) break;
        printf("ok\n");
    }
    return 0;
}
