/** The ‹ / › chevron on the photo carousel's arrows and the home page rails' arrows. */
export function Chevron({
  dir,
  className = '',
  strokeWidth = 2.5,
}: {
  dir: 'left' | 'right';
  className?: string;
  strokeWidth?: number;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={dir === 'left' ? 'm15 6-6 6 6 6' : 'm9 6 6 6-6 6'} />
    </svg>
  );
}
