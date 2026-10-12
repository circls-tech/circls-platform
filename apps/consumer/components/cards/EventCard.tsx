import Link from 'next/link';
import { ImageCarousel } from '@/components/ImageCarousel';
import { LikeButton } from '@/components/LikeButton';
import { SportImage } from '@/components/SportImage';
import { countryOfAddress, currencyForCountry, formatDayMonth, formatTime, formatPaise } from '@/lib/format';
import type { PublicEventWithVenue } from '@/lib/api/types';

export function EventCard({ event, className = '' }: { event: PublicEventWithVenue; className?: string }) {
  const { day, month } = formatDayMonth(event.startsAt);
  const currency = currencyForCountry(countryOfAddress(event.locAddressJson));
  return (
    // The heart is a sibling of the link, not a child: a button inside an
    // anchor is invalid HTML, and this keeps the whole card clickable.
    <div className={`relative ${className}`}>
    <Link
      href={`/events/${event.id}`}
      className="block h-full overflow-hidden rounded-card border-[2px] border-ink bg-sky-soft shadow-offset-sm transition-[transform,box-shadow] duration-150 hover:-translate-x-0.5 hover:-translate-y-0.5 hover:shadow-offset"
    >
      <div className="relative">
        <ImageCarousel
          images={event.images}
          alt={`${event.name} at ${event.locationName}`}
          className="h-[140px]"
          fallback={
            <SportImage
              input={{ tags: event.venueTags }}
              alt={`${event.name} at ${event.locationName}`}
              className="h-[140px]"
            />
          }
        />
        <div className="absolute left-2.5 top-2.5 z-10 rounded-lg border-[2px] border-ink bg-white px-2.5 py-1 text-center leading-none shadow-offset-sm">
          <div className="font-display text-lg font-extrabold text-ink">{day}</div>
          <div className="text-[9px] font-bold uppercase tracking-widest text-coral-deep">{month}</div>
        </div>
        {/* Sits left of the heart in the top-right corner. */}
        {(event.seriesCount ?? 1) > 1 && (
          <div className="absolute right-12 top-2.5 z-10 rounded-lg border-[2px] border-ink bg-white px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-ink shadow-offset-sm">
            {event.seriesCount} dates
          </div>
        )}
      </div>
      <div className="p-4">
        <h3 className="font-display text-[18px] font-extrabold text-ink">{event.name}</h3>
        <p className="mt-0.5 text-sm text-text-secondary">
          {event.locationName} · {formatTime(event.startsAt)}
          {(event.seriesCount ?? 1) > 1 && ' · repeats'}
        </p>
        <p className="mt-2 text-sm font-semibold text-ink">{formatPaise(event.pricePaise, currency)}</p>
      </div>
    </Link>
      <LikeButton itemType="event" itemId={event.id} name={event.name} className="absolute right-2.5 top-2.5 z-10" />
    </div>
  );
}
