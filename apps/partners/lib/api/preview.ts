import { useMutation } from '@tanstack/react-query';
import { apiFetch } from './client';

/** A listing that has a customer-facing page of its own. */
export type ListingPreviewType = 'venue' | 'event' | 'membership';

/** `POST /v1/tenants/:tenantId/listings/:type/:id/preview` — a short-lived link
 *  to the listing on the consumer site, readable there whatever its status. */
export interface ListingPreview {
  /** The consumer-site URL, token included: open it, or frame it. */
  url: string;
  type: ListingPreviewType;
  id: string;
  expiresAt: string;
}

/**
 * Mint a "see it as a customer" link for one of the organisation's listings.
 * Minted fresh each time a preview opens — the link expires on its own, so
 * there is nothing to cache.
 */
export function useCreateListingPreview(tenantId: string) {
  return useMutation({
    mutationFn: (args: { type: ListingPreviewType; id: string }) =>
      apiFetch<ListingPreview>(
        `/v1/tenants/${tenantId}/listings/${args.type}/${args.id}/preview`,
        { method: 'POST' },
      ),
  });
}
