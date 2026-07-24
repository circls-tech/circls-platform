import type { Metadata } from 'next';
import Link from 'next/link';
import { Header } from '@/components/Header';
import { BrandMark } from '@/lib/ui';

export const metadata: Metadata = {
  title: 'Help & Support — circls',
  description:
    'How to book courts, register for events, use memberships, manage bookings, and get refunds on circls.',
};

type Section = {
  id: string;
  title: string;
  body: React.ReactNode;
};

const SECTIONS: Section[] = [
  {
    id: 'booking',
    title: 'How booking a court works',
    body: (
      <ol className="mt-2 list-decimal space-y-1.5 pl-5">
        <li>
          Open <Link href="/venues" className="font-semibold underline">Venues</Link> and pick a venue near you.
        </li>
        <li>Choose the sport and the date you want to play.</li>
        <li>Select one or more open time slots — pick as many as you need in one go.</li>
        <li>Review your slots together and confirm the booking.</li>
        <li>Pay securely to lock it in. You’ll get a confirmation right away.</li>
      </ol>
    ),
  },
  {
    id: 'events',
    title: 'Events & registration',
    body: (
      <>
        <p className="mt-2">
          Browse one-off games, tournaments and meet-ups under{' '}
          <Link href="/events" className="font-semibold underline">Events</Link>. Open an event to see the
          date, venue, who’s organising it and any entry fee.
        </p>
        <p className="mt-2">
          Tap register to claim your spot. Paid events are confirmed once payment goes through; free events
          are confirmed instantly. Registered events show up in My bookings alongside your court bookings.
        </p>
      </>
    ),
  },
  {
    id: 'memberships',
    title: 'Memberships',
    body: (
      <>
        <p className="mt-2">
          A membership is a plan you buy from a venue or organiser that gives you perks at their courts and
          events. Browse what’s on offer under{' '}
          <Link href="/memberships" className="font-semibold underline">Memberships</Link>.
        </p>
        <p className="mt-2">Depending on the plan, a membership can include:</p>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>Priority or earlier access to booking slots.</li>
          <li>A set of included or free slots each cycle.</li>
          <li>Member pricing on bookings and events.</li>
        </ul>
        <p className="mt-2">
          Once active, your benefits apply automatically at checkout — no codes to remember.
        </p>
      </>
    ),
  },
  {
    id: 'payments',
    title: 'Payments & refunds',
    body: (
      <>
        <p className="mt-2">
          Payments are processed securely at checkout. Your booking is confirmed only once payment
          succeeds — if a payment fails, the slot stays open and you can try again.
        </p>
        <p className="mt-2">
          Refunds depend on timing and the venue’s policy. For the full rules on cancellations and
          eligibility, see our{' '}
          <Link href="/refund" className="font-semibold underline">Refund Policy</Link>.
        </p>
      </>
    ),
  },
  {
    id: 'managing',
    title: 'Managing your bookings',
    body: (
      <>
        <p className="mt-2">
          All your court bookings, event registrations and membership purchases live in one place:{' '}
          <Link href="/me/bookings" className="font-semibold underline">My bookings</Link>. Sign in to view
          upcoming and past activity and check your booking details.
        </p>
        <p className="mt-2">
          Need to cancel or change something? Open the booking from My bookings — what you can do depends on
          the venue’s policy and how close it is to the start time.
        </p>
      </>
    ),
  },
];

export default function HelpPage() {
  return (
    <div className="min-h-screen">
      <Header />
      <main className="mx-auto max-w-3xl px-4 py-10">
        <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-widest text-coral-deep">
          <BrandMark className="h-4 w-4" />
          <span>circls · Help &amp; Support</span>
        </div>
        <h1 className="mt-1 font-display text-3xl font-extrabold text-ink">Help &amp; Support</h1>
        <p className="mt-1 text-sm text-text-secondary">
          Quick answers for booking courts, joining events, and using memberships.
        </p>

        {/* Jump links */}
        <nav aria-label="Help topics" className="mt-5 flex flex-wrap gap-2">
          {SECTIONS.map((s) => (
            <a
              key={s.id}
              href={`#${s.id}`}
              className="rounded-lg border-[1.5px] border-ink bg-white px-3 py-1.5 text-sm font-semibold text-ink hover:bg-coral-soft"
            >
              {s.title}
            </a>
          ))}
        </nav>

        <div className="mt-8 space-y-5">
          {SECTIONS.map((s) => (
            <section
              key={s.id}
              id={s.id}
              className="scroll-mt-24 rounded-card border-[2.5px] border-ink bg-white p-5 text-sm leading-relaxed text-ink/90 shadow-offset-sm"
            >
              <h2 className="font-display text-lg font-extrabold text-ink">{s.title}</h2>
              {s.body}
            </section>
          ))}
        </div>

        {/* Contact */}
        <section
          id="contact"
          className="mt-8 scroll-mt-24 rounded-card border-[2.5px] border-ink bg-coral-soft p-5 text-sm text-ink shadow-offset-sm"
        >
          <h2 className="font-display text-lg font-extrabold text-ink">Still need help?</h2>
          <p className="mt-2">
            Can’t find what you’re looking for? Email us and we’ll get back to you. Include your booking
            reference if your question is about a specific booking.
          </p>
          <p className="mt-3">
            <a
              href="mailto:contact@gibbous.io"
              className="font-semibold underline"
            >
              contact@gibbous.io
            </a>
          </p>
        </section>
      </main>
    </div>
  );
}
