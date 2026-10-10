import Link from 'next/link';
import { ImageCarousel } from '@/components/ImageCarousel';
import { LikeButton } from '@/components/LikeButton';
import { SportImage } from '@/components/SportImage';
import { Badge } from '@/lib/ui';
import { matchSport } from '@/lib/sportImages';
import { cityOf } from '@/lib/location/geo';
import type { PublicVenue } from '@/lib/api/types';

export function VenueCard({ venue, className = '' }: { venue: PublicVenue; className?: string }) {
  const sport = matchSport(venue.tags);
  const city = cityOf(venue.addressJson);
  return (
    // The heart is a sibling of the link, not a child: a button inside an
    // anchor is invalid HTML, and this keeps the whole card clickable.
    <div className={`relative ${className}`}>
    <Link
      href={`/venues/${venue.id}`}
      className="block h-full overflow-hidden rounded-card border-[2px] border-ink bg-white shadow-offset-sm transition-[transform,box-shadow] duration-150 hover:-translate-x-0.5 hover:-translate-y-0.5 hover:shadow-offset"
    >
      <ImageCarousel
        images={venue.images}
        alt={`${venue.name}${sport ? ` — ${sport}` : ''}`}
        label={sport ?? undefined}
        className="h-[140px]"
        fallback={
          <SportImage
            input={{ tags: venue.tags }}
            alt={`${venue.name}${sport ? ` — ${sport}` : ''}`}
            label={sport ?? undefined}
            className="h-[140px]"
          />
        }
      />
      <div className="p-4">
        <h3 className="font-display text-[19px] font-extrabold text-ink">{venue.name}</h3>
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
      <LikeButton itemType="venue" itemId={venue.id} name={venue.name} className="absolute right-2.5 top-2.5 z-10" />
    </div>
  );
}
