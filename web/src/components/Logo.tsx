/** The in-app mark. Swap the artwork by replacing web/public/icons/mark.svg (no code change). */
export function Logo({ size = 28 }: { size?: number }) {
  return <img src="/icons/mark.svg" width={size} height={size} alt="" draggable={false} />;
}
