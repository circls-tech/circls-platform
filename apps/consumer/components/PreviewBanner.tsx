'use client';

/**
 * Stands in for the site header on a listing page opened in preview mode
 * (see lib/preview.ts): says what the viewer is looking at and that nothing
 * on the page can be booked. Kept to one line so the listing underneath is
 * what fills the frame.
 */
export function PreviewBanner({
  noun,
}: {
  /** What is being previewed, for the copy: "event", "membership", "venue". */
  noun: string;
}) {
  return (
    <div
      role="status"
      className="sticky top-0 z-40 border-b-[2px] border-ink bg-pastel-butter px-4 py-2 text-center text-xs font-semibold text-ink sm:text-sm"
    >
      <span className="mr-2 rounded-[var(--radius)] border-[1.5px] border-ink bg-white px-1.5 py-0.5 font-display text-[10px] font-extrabold uppercase tracking-wide">
        Preview
      </span>
      This is how customers will see this {noun}. Booking is turned off in preview.
    </div>
  );
}
