import { redirect } from 'next/navigation';

/**
 * The refund flow used to live at /bookings/[id]/cancel. Kept as a permanent
 * redirect so bookmarks and links sent to partners before the rename still work.
 */
export default async function LegacyCancelRedirect({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/bookings/${id}/refund`);
}
