'use client';
import { useActivity } from '@/lib/activity/ActivityProvider';
import { inviteText, type BookingInvite } from '@/lib/booking_invite';
import { listingUrl, whatsappUrl } from '@/lib/share';
import { useShareTap } from '@/lib/useShareTap';
import { Button } from '@/lib/ui';
import { CheckIcon, ShareIcon } from '@/components/ShareButton';

const NOTE_MS = 4000;

/** A speech bubble: the chat-app mark on the WhatsApp button. */
function ChatIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M20.5 11.5a8.5 8.5 0 0 1-12.6 7.4L3.5 20.5l1.6-4.3A8.5 8.5 0 1 1 20.5 11.5z" />
    </svg>
  );
}

/**
 * "Invite friends" on a booking, two ways: straight into WhatsApp, where most
 * invites go, or anywhere else through the device's share sheet ("More"; a
 * copy of the note and link where there is no sheet). Both send the booking's
 * invite note (see lib/booking_invite) and its listing's link.
 *
 * Every tap is logged as a `share` of the listing, like `ShareButton`'s, so
 * the admin reports count it with the listing's other shares; `props.from`
 * says it came from a booking, and a WhatsApp tap has the outcome `whatsapp`.
 * If neither the sheet nor the clipboard is allowed, the note is shown to
 * copy by hand until the next tap: the address bar here is the booking's,
 * which is no use to a friend.
 */
export function InviteButton({
  invite,
  from,
  wide = false,
  label,
  className = '',
}: {
  invite: BookingInvite;
  /** Where the tap happened: the booking page, or checkout's success screen. */
  from: 'booking' | 'checkout';
  /** Buttons share the full width at every size (in a modal); otherwise only on phones. */
  wide?: boolean;
  /** A line above the buttons, when the page around them doesn't say what they're for. */
  label?: string;
  className?: string;
}) {
  const { last, recent, tap } = useShareTap(NOTE_MS);
  const activity = useActivity();
  // Built at click time, never during server rendering.
  const urlNow = () => listingUrl(window.location.origin, invite.itemType, invite.itemId);

  function onWhatsApp() {
    window.open(whatsappUrl(inviteText(invite, urlNow())), '_blank', 'noopener,noreferrer');
    activity.log('share', { itemType: invite.itemType, itemId: invite.itemId, props: { from, outcome: 'whatsapp' } });
  }

  function onMore() {
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
  const size = wide ? 'flex-1' : 'flex-1 sm:flex-none';

  return (
    <div className={className}>
      {label && <p className="mb-2 text-sm font-semibold text-ink">{label}</p>}
      <div className="flex gap-2">
        <Button onClick={onWhatsApp} aria-label="Invite friends on WhatsApp" className={size}>
          <ChatIcon className="h-4 w-4" />
          <span>WhatsApp</span>
        </Button>
        <Button
          variant="secondary"
          onClick={onMore}
          aria-label={copied ? 'Invite copied' : 'More ways to invite friends'}
          className={size}
        >
          {copied ? <CheckIcon className="h-4 w-4" /> : <ShareIcon className="h-4 w-4" />}
          <span>{copied ? 'Copied' : 'More'}</span>
        </Button>
      </div>
      {/* Always in the DOM: a live region that appears with its text is
          usually not announced. */}
      <p role="status" className={copied ? 'mt-2 text-xs text-text-secondary' : 'sr-only'}>
        {copied ? 'Copied with the link. Paste it into a chat.' : ''}
      </p>
      {manual && (
        <div className="mt-3">
          <p className="text-xs text-text-secondary">Copy this and send it to your friends:</p>
          <p className="mt-1 select-all whitespace-pre-line break-words rounded-[var(--radius)] border-[1.5px] border-dashed border-ink/25 bg-surface-2 px-3 py-2 text-sm text-ink">
            {manual}
          </p>
        </div>
      )}
    </div>
  );
}
