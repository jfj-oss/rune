// A tiny FIFO with concurrency 1, used to keep at most one ffmpeg decoding
// waveform data at a time. Interactive requests (a user opened a track) jump
// ahead of speculative prefetch work; prefetch entries are bounded so a long
// queue cannot pile up.
export class PeakQueue {
  private active = 0;
  private readonly foreground: (() => void)[] = [];
  private readonly background: (() => void)[] = [];

  constructor(
    private readonly limit = 1,
    private readonly maxBackground = 24,
  ) {}

  get backgroundPending(): number {
    return this.background.length;
  }

  get pending(): number {
    return this.foreground.length + this.background.length;
  }

  /** Queue `fn`; foreground jobs run before background (prefetch) jobs. */
  run<T>(fn: () => Promise<T>, background = false): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const task = (): void => {
        this.active += 1;
        fn()
          .then(resolve, reject)
          .finally(() => {
            this.active -= 1;
            this.pump();
          });
      };
      if (background) this.background.push(task);
      else this.foreground.push(task);
      this.pump();
    });
  }

  /** True when another prefetch job would exceed the background queue bound. */
  get backgroundFull(): boolean {
    return this.background.length >= this.maxBackground;
  }

  private pump(): void {
    while (this.active < this.limit) {
      const task = this.foreground.shift() ?? this.background.shift();
      if (!task) return;
      task();
    }
  }
}
