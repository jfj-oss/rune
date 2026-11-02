/** Suspense fallback for lazily loaded routes: a light page-shaped skeleton, never a blank flash. */
export function PageSkeleton() {
  return (
    <div className="page" aria-busy="true" aria-label="Loading page">
      <header className="pagehead">
        <div className="skel skel--title shimmer" style={{ width: 220 }} />
        <div className="skel skel--line shimmer" style={{ width: 300, marginTop: 6 }} />
      </header>
      <div className="grid grid--lib" aria-hidden>
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="card card--skeleton">
            <div className="card__art"><div className="cover shimmer" /></div>
            <div className="skel skel--line" />
            <div className="skel skel--line skel--short" />
          </div>
        ))}
      </div>
    </div>
  );
}
