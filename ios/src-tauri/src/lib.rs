//! The rune iPhone shell.
//!
//! There is no server address in this repository: the app opens a small bundled connect screen,
//! asks for the address of the user's own rune server, checks `<server>/api/health`, remembers it,
//! and only then loads that server's web app in the same webview. The address is kept in the
//! app's own config directory (`server.txt` in the iOS sandbox).
//!
//! The web app is not bundled here. The WKWebView loads it from the user's server, so the app
//! behaves exactly like the browser client (subject to the iOS notes in docs/IOS.md).

use std::fs;
use std::io::ErrorKind;
use std::path::PathBuf;
use std::time::Duration;

use serde::Serialize;
use tauri::Manager;
use url::Url;

/// A deliberately unresolvable URL the injected long-press gesture navigates to. `on_navigation`
/// cancels it and loads the bundled connect screen instead, so remote pages need no Tauri IPC.
const SETTINGS_MARKER: &str = "https://rune-native.invalid/settings";

/// The bundled connect screen, with `?settings=1` so it does not immediately reconnect.
const LOCAL_SETTINGS_URL: &str = "tauri://localhost/index.html?settings=1";

/// Runs at document start in every main-frame page, including the remote web app.
const INIT_SCRIPT: &str = r#"
(function () {
  // The capability flag the web app reads (see docs/IOS.md). Do not put anything else here:
  // the web app may be served by any rune server, and the flag is its only signal that it is
  // inside the iPhone shell rather than a browser.
  window.__runeNative = Object.freeze({ platform: 'ios' });

  // An app, not a web page: no pinch zoom, and no zoom-in when a text box under 16 px is tapped (iOS does that).
  // Browsers opening the same rune server keep normal zoom; this only runs in the iPhone shell.
  (function noZoom() {
    var content = 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover';
    function apply() {
      var m = document.querySelector('meta[name=viewport]');
      if (!m) { m = document.createElement('meta'); m.name = 'viewport'; (document.head || document.documentElement).appendChild(m); }
      if (m.content !== content) m.content = content;
      if (!document.getElementById('rune-native-nozoom')) {
        var st = document.createElement('style'); st.id = 'rune-native-nozoom';
        st.textContent = 'html{touch-action:pan-x pan-y;-webkit-text-size-adjust:100%}input,textarea,select{font-size:max(16px,1em)!important}';
        (document.head || document.documentElement).appendChild(st);
      }
    }
    apply();
    document.addEventListener('DOMContentLoaded', apply);
    document.addEventListener('gesturestart', function (e) { e.preventDefault(); }, { passive: false });
    document.addEventListener('gesturechange', function (e) { e.preventDefault(); }, { passive: false });
  })();

  // The bundled connect screen is already the settings screen; only the remote web app needs the
  // gesture. Tauri's asset page is tauri://localhost, the server page is http(s).
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
  if (window.__runeNativeSettingsBound) return;
  window.__runeNativeSettingsBound = true;

  var timer = 0, startX = 0, startY = 0;
  function cancel() {
    if (!timer) return;
    clearTimeout(timer);
    timer = 0;
  }
  function titleOf(target) {
    if (!target || target.nodeType !== 1) target = target && target.parentElement;
    if (!target || !target.closest) return null;
    // The page title on every screen (the home greeting, album and artist names). The Now Playing
    // sheet has its own h1 for the track, which is not a page title and must not open this screen.
    if (target.closest('.np__title')) return null;
    return target.closest('h1, .side__brand');
  }
  function onStart(e) {
    if (e.touches.length !== 1 || !titleOf(e.target)) return;
    var t = e.touches[0];
    startX = t.clientX;
    startY = t.clientY;
    cancel();
    // Long press the page title to change the server address.
    timer = setTimeout(function () {
      timer = 0;
      location.href = 'https://rune-native.invalid/settings';
    }, 800);
  }
  function onMove(e) {
    if (!timer || e.touches.length !== 1) return;
    var t = e.touches[0];
    if (Math.abs(t.clientX - startX) > 12 || Math.abs(t.clientY - startY) > 12) cancel();
  }
  document.addEventListener('touchstart', onStart, { capture: true, passive: true });
  document.addEventListener('touchmove', onMove, { capture: true, passive: true });
  document.addEventListener('touchend', cancel, true);
  document.addEventListener('touchcancel', cancel, true);
  // A held finger on a heading should not also open WebKit's selection menu.
  document.addEventListener('contextmenu', function (e) {
    if (titleOf(e.target)) e.preventDefault();
  }, true);
})();
"#;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ServerInfo {
    /// The normalised origin, without a trailing slash.
    url: String,
    version: String,
    /// The rune server's own health verdict; false still means the web app is reachable.
    ok: bool,
}

fn server_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("could not find the app's data directory: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    Ok(dir.join("server.txt"))
}

#[tauri::command]
fn get_server(app: tauri::AppHandle) -> Option<String> {
    let path = server_file(&app).ok()?;
    let saved = fs::read_to_string(path).ok()?;
    let saved = saved.trim().to_string();
    if saved.is_empty() {
        None
    } else {
        Some(saved)
    }
}

fn save_server(app: &tauri::AppHandle, url: &str) -> Result<(), String> {
    let path = server_file(app)?;
    let tmp = path.with_extension("txt.tmp");
    fs::write(&tmp, format!("{url}\n")).map_err(|e| format!("could not save the address: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("could not save the address: {e}"))?;
    Ok(())
}

#[tauri::command]
fn clear_server(app: tauri::AppHandle) -> Result<(), String> {
    let path = server_file(&app)?;
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("could not forget the address: {e}")),
    }
}

/// Turn what was typed into one or two candidate origins. A bare host is tried over https first,
/// then http (a LAN server without a certificate); an explicit scheme is taken as written.
fn parse_candidates(raw: &str) -> Result<Vec<Url>, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("Enter your server's address.".into());
    }
    if !raw.contains("://") {
        return Ok(vec![
            normalise(&format!("https://{raw}"))?,
            normalise(&format!("http://{raw}"))?,
        ]);
    }
    Ok(vec![normalise(raw)?])
}

fn normalise(raw: &str) -> Result<Url, String> {
    let mut url = Url::parse(raw).map_err(|_| "That does not look like a web address.".to_string())?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("Use an http:// or https:// address.".into());
    }
    if url.host_str().is_none() {
        return Err("The address has no host name.".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Leave the user name and password out of the address.".into());
    }
    // rune serves its web app at the root; a path, query or fragment is not part of the server address.
    url.set_path("/");
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

fn origin_of(url: &Url) -> String {
    url.origin().ascii_serialization()
}

fn friendly_error(url: &Url, err: &reqwest::Error) -> String {
    let origin = origin_of(url);
    if err.is_timeout() {
        format!("Timed out reaching {origin}. Is the PC awake and on the same network?")
    } else if err.is_connect() {
        format!("Could not connect to {origin}. Is rune running there, and are you on Tailscale or the same Wi-Fi?")
    } else if err.is_builder() || err.is_request() {
        format!("{origin} did not accept the request. Check the address and port.")
    } else {
        format!("Could not reach {origin}.")
    }
}

async fn probe(base: &Url) -> Result<ServerInfo, String> {
    let health = base
        .join("api/health")
        .map_err(|_| "The address cannot be used with /api/health.".to_string())?;
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(8))
        .user_agent(concat!("rune-ios/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| format!("could not start the check: {e}"))?;

    let res = client
        .get(health)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| friendly_error(base, &e))?;

    if !res.status().is_success() {
        return Err(format!(
            "{} answered {} at /api/health — that does not look like rune.",
            origin_of(base),
            res.status().as_u16()
        ));
    }

    let body: serde_json::Value = res
        .json()
        .await
        .map_err(|_| format!("{} answered, but not with rune's health JSON.", origin_of(base)))?;
    let version = body
        .get("version")
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("{} is not a rune server: /api/health has no version.", origin_of(base)))?;
    let ok = body.get("ok").and_then(|v| v.as_bool()).unwrap_or(true);

    Ok(ServerInfo {
        url: origin_of(base),
        version: version.to_string(),
        ok,
    })
}

/// Check the address and, only if a rune server answers, remember it.
#[tauri::command]
async fn connect_server(app: tauri::AppHandle, url: String) -> Result<ServerInfo, String> {
    let candidates = parse_candidates(&url)?;
    let mut last_error = String::from("Could not reach the server.");
    for base in candidates {
        match probe(&base).await {
            Ok(info) => {
                save_server(&app, &info.url)?;
                return Ok(info);
            }
            Err(e) => last_error = e,
        }
    }
    Err(last_error)
}

fn is_settings_marker(url: &Url) -> bool {
    url.as_str() == SETTINGS_MARKER
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![get_server, connect_server, clear_server])
        .setup(|app| {
            let navigation_app = app.handle().clone();
            tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("rune")
            .initialization_script(INIT_SCRIPT)
            .on_navigation(move |url| {
                if is_settings_marker(url) {
                    // Do not start a WebKit navigation from inside its own navigation decision:
                    // let this one be cancelled, then load the bundled settings screen.
                    let app = navigation_app.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(Duration::from_millis(80));
                        let handle = app.clone();
                        let _ = app.run_on_main_thread(move || {
                            if let Some(window) = handle.get_webview_window("main") {
                                if let Ok(local) = Url::parse(LOCAL_SETTINGS_URL) {
                                    let _ = window.navigate(local);
                                }
                            }
                        });
                    });
                    return false;
                }
                true
            })
            .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running rune");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bare_host_tries_https_then_http() {
        let candidates = parse_candidates("192.168.1.20:4545").unwrap();
        assert_eq!(candidates.len(), 2);
        assert_eq!(origin_of(&candidates[0]), "https://192.168.1.20:4545");
        assert_eq!(origin_of(&candidates[1]), "http://192.168.1.20:4545");
    }

    #[test]
    fn explicit_scheme_is_kept_and_the_path_is_dropped() {
        let candidates =
            parse_candidates("http://192.168.1.20:4545/rune/?q=1#now").unwrap();
        assert_eq!(candidates.len(), 1);
        assert_eq!(origin_of(&candidates[0]), "http://192.168.1.20:4545");
    }

    #[test]
    fn rejects_non_web_schemes() {
        assert!(parse_candidates("ftp://example.test").is_err());
        assert!(parse_candidates("file:///tmp/rune").is_err());
    }

    #[test]
    fn rejects_empty_and_credentialed_addresses() {
        assert!(parse_candidates("   ").is_err());
        assert!(parse_candidates("https://user:secret@example.test:8445").is_err());
    }

    #[test]
    fn only_the_exact_settings_marker_is_intercepted() {
        assert!(is_settings_marker(&Url::parse(SETTINGS_MARKER).unwrap()));
        assert!(!is_settings_marker(&Url::parse("https://example.test/settings").unwrap()));
        assert!(!is_settings_marker(
            &Url::parse("https://rune-native.invalid/settings?from=title").unwrap()
        ));
    }
}
