export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`shimmer rounded-card bg-border/60 ${className}`} />;
}

/** A card-shaped skeleton matching VenueCard dimensions. */
export function CardSkeleton() {
  return (
    <div className="overflow-hidden rounded-card border border-border bg-white">
      <Skeleton className="h-[140px] rounded-none" />
      <div className="space-y-2 p-4">
        <Skeleton className="h-4 w-2/3 rounded" />
        <Skeleton className="h-3 w-1/2 rounded" />
      </div>
    </div>
  );
}
