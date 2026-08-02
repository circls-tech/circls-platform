/**
 * Postal address rendered as a maps link — coordinates when we have them
 * (exact pin), otherwise the address text as the search query. With
 * coordinates but no printable address the link still renders, labelled
 * "View on map". Google Maps URLs open the native app on both Android and
 * iOS when installed.
 */
export function AddressLink({
  addressJson,
  lat,
  lng,
  className = '',
}: {
  addressJson: Record<string, unknown> | null;
  lat?: number | null;
  lng?: number | null;
  className?: string;
}) {
  const parts = ['line1', 'line2', 'city', 'state', 'pincode']
    .map((k) => addressJson?.[k])
    .filter((v): v is string => typeof v === 'string' && v.length > 0);
  const hasCoords = lat != null && lng != null;
  if (parts.length === 0 && !hasCoords) return null;
  const query = hasCoords ? `${lat},${lng}` : encodeURIComponent(parts.join(', '));
  return (
    <a
      href={`https://www.google.com/maps/search/?api=1&query=${query}`}
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-flex items-center gap-1.5 text-sm text-text-secondary underline decoration-ink/30 underline-offset-2 transition-colors hover:text-coral-deep hover:decoration-current ${className}`}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-4 w-4 shrink-0"
        aria-hidden
      >
        <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" />
        <circle cx="12" cy="10" r="3" />
      </svg>
      {parts.length > 0 ? parts.join(', ') : 'View on map'}
    </a>
  );
}
