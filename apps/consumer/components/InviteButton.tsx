'use client';
import { inviteText, type BookingInvite } from '@/lib/booking_invite';
import { listingUrl } from '@/lib/share';
import { useShareTap } from '@/lib/useShareTap';
import { Button } from '@/lib/ui';
import { CheckIcon, ShareIcon } from '@/components/ShareButton';

const NOTE_MS = 4000;

/**
 * "Invite friends" on a booking: sends the booking's invite note (see
 * lib/booking_invite) with its listing's link through the device's share
 * sheet, where WhatsApp and every other app are a tap away, or copies both
 * where there is no sheet.
 *
 * Every tap is logged as a `share` of the listing, like `ShareButton`'s, so
 * the admin reports count it with the listing's other shares; `props.from`
 * says it came from a booking. If neither the sheet nor the clipboard is
 * allowed, the note is shown to copy by hand until the next tap: the address
 * bar here is the booking's, which is no use to a friend.
 */
export function InviteButton({
  invite,
  from,
  wide = false,
  className = '',
}: {
  invite: BookingInvite;
  /** Where the tap happened: the booking page, or checkout's success screen. */
  from: 'booking' | 'checkout';
  /** Full width at every size (in a modal); otherwise only on phones. */
  wide?: boolean;
  className?: string;
}) {
  const { last, recent, tap } = useShareTap(NOTE_MS);
  // Built at click time, never during server rendering.
  const urlNow = () => listingUrl(window.location.origin, invite.itemType, invite.itemId);

  function onClick() {
    const url = urlNow();
    void tap(
      { title: invite.title, text: invite.message, url },
      { itemType: invite.itemType, itemId: invite.itemId, props: { from } },
      { copy: inviteText(invite, url) },
    );
  }

  const copied = recent && last === 'copied';
  // `last` is only set after a tap, so this never runs on the server.
  const manual = last === 'unavailable' ? inviteText(invite, urlNow()) : null;

  return (
    <div className={className}>
      <Button variant="secondary" onClick={onClick} className={wide ? 'w-full' : 'w-full sm:w-auto'}>
        {copied ? <CheckIcon className="h-4 w-4" /> : <ShareIcon className="h-4 w-4" />}
        <span>{copied ? 'Invite copied' : 'Invite friends'}</span>
      </Button>
      {/* Always in the DOM: a live region that appears with its text is
          usually not announced. */}
      <p role="status" className={copied ? 'mt-2 text-xs text-text-secondary' : 'sr-only'}>
        {copied ? 'Copied with the link. Paste it into a chat.' : ''}
      </p>
      {manual && <ManualCopy text={manual} />}
    </div>
  );
}

/** The note and link, to copy by hand where neither a share sheet nor the clipboard is allowed. */
export function ManualCopy({ text }: { text: string }) {
  return (
    <div className="mt-3">
      <p className="text-xs text-text-secondary">Copy this and send it to your friends:</p>
      <p className="mt-1 select-all whitespace-pre-line break-words rounded-[var(--radius)] border-[1.5px] border-dashed border-ink/25 bg-surface-2 px-3 py-2 text-sm text-ink">
        {text}
      </p>
    </div>
  );
}
