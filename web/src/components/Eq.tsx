/** Animated "now playing" bars; static when paused. */
export function Eq({ playing }: { playing: boolean }) {
  return (
    <span className={`eq${playing ? ' is-playing' : ''}`} aria-hidden>
      <i /><i /><i />
    </span>
  );
}
