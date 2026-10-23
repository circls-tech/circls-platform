'use client';
import { useParams, useSearchParams } from 'next/navigation';
import { VenueImages } from '@/components/VenueImages';
import { VenueDetailsForm } from '@/components/VenueDetailsForm';
import { RejectionNotice } from '@/components/RejectionNotice';
import { useVenue } from '@/lib/api/queries';
import { useCan } from '@/lib/use_can';
import { BackLink, StatusPill } from '@/lib/ui';

/**
 * A venue's setup — the details customers read, and its photos — on a page
 * of its own. It used to sit at the top of the venue page, above the arenas,
 * so the thing done daily (opening a desk) was under the thing done once.
 * The venue page now leads with the arenas and sends editing here.
 */
export default function VenueDetailsPage() {
  const { venueId } = useParams<{ venueId: string }>();
  const tenantId = useSearchParams().get('tenantId') ?? '';
  const { data: venue } = useVenue(venueId);
  // The venue's own organisation decides, once it has loaded.
  const canEditVenue = useCan('venues.write', venue?.tenantId ?? tenantId);
  const venueHref = `/venues/${venueId}${tenantId ? `?tenantId=${tenantId}` : ''}`;

  return (
    <div className="flex flex-col gap-6">
      <BackLink href={venueHref}>{venue?.name ?? 'Venue'}</BackLink>
      {venue && (
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-[family-name:var(--font-display)] text-2xl font-extrabold tracking-tight text-[#17151D]">
            {venue.name}
          </h1>
          <StatusPill
            status={venue.status}
            {...(venue.status === 'suspended' ? { label: 'Closed' } : {})}
          />
          <span className="text-sm text-slate-500">Details and photos</span>
        </div>
      )}
      {/* Fixing a rejected venue happens here; Submit again is on the venue page. */}
      {venue?.status === 'rejected' && (
        <RejectionNotice rejection={venue.rejection} noun="venue" canWrite={canEditVenue} />
      )}
      {venue && <VenueDetailsForm venue={venue} />}
      <VenueImages venueId={venueId} readOnly={!canEditVenue} />
    </div>
  );
}
