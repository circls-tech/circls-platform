import Link from 'next/link';
import { SportImage } from '@/components/SportImage';
import { formatDayMonth, formatTime, formatPaise } from '@/lib/format';
import type { PublicEventWithVenue } from '@/lib/api/types';

export function EventCard({ event, className = '' }: { event: PublicEventWithVenue; className?: string }) {
  const { day, month } = formatDayMonth(event.startsAt);
  return (
    <Link
      href={`/events/${event.id}`}
      className={`block overflow-hidden rounded-card border border-border bg-white transition-all hover:-translate-y-1 hover:shadow-[0_16px_36px_rgba(15,28,46,0.16)] ${className}`}
    >
      <div className="relative">
        <SportImage
          input={{ tags: event.venueTags }}
          alt={`${event.name} at ${event.locationName}`}
          className="h-[140px]"
        />
        <div className="absolute left-2.5 top-2.5 rounded-lg bg-white px-2.5 py-1 text-center leading-none shadow-md">
          <div className="font-display text-lg font-bold text-ink">{day}</div>
          <div className="text-[9px] font-bold uppercase tracking-widest text-gold-600">{month}</div>
        </div>
      </div>
      <div className="p-4">
        <h3 className="font-display text-[18px] font-semibold text-ink">{event.name}</h3>
        <p className="mt-0.5 text-sm text-text-secondary">
          {event.locationName} · {formatTime(event.startsAt)}
        </p>
        <p className="mt-2 text-sm font-semibold text-ink">{formatPaise(event.pricePaise)}</p>
      </div>
    </Link>
  );
}
