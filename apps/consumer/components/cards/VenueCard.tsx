import Link from 'next/link';
import { SportImage } from '@/components/SportImage';
import { Badge } from '@/lib/ui';
import { matchSport } from '@/lib/sportImages';
import type { PublicVenue } from '@/lib/api/types';

function cityOf(addressJson: Record<string, unknown> | null): string | null {
  const c = addressJson?.['city'];
  return typeof c === 'string' && c ? c : null;
}

export function VenueCard({ venue, className = '' }: { venue: PublicVenue; className?: string }) {
  const sport = matchSport(venue.tags);
  const city = cityOf(venue.addressJson);
  return (
    <Link
      href={`/venues/${venue.id}`}
      className={`block overflow-hidden rounded-card border border-border bg-white transition-all hover:-translate-y-1 hover:shadow-[0_16px_36px_rgba(15,28,46,0.16)] ${className}`}
    >
      <SportImage
        input={{ imageUrl: venue.imageUrl, tags: venue.tags }}
        alt={`${venue.name}${sport ? ` — ${sport}` : ''}`}
        label={sport ?? undefined}
        className="h-[140px]"
      />
      <div className="p-4">
        <h3 className="font-display text-[19px] font-semibold text-ink">{venue.name}</h3>
        {city && <p className="mt-0.5 text-sm text-text-secondary">{city}</p>}
        {venue.tags.length > 0 && (
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {venue.tags.slice(0, 3).map((t) => (
              <Badge key={t} tone="sport" label={t} />
            ))}
          </div>
        )}
      </div>
    </Link>
  );
}
