/** Ambient background: three stacked fixed gradient layers; only opacity is animated (compositor only). */
export function Ambient() {
  return (
    <div className="ambient" aria-hidden="true">
      <i className="ambient__l ambient__l--blue" />
      <i className="ambient__l ambient__l--purple" />
      <i className="ambient__l ambient__l--green" />
    </div>
  );
}
