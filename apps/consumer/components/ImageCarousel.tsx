'use client';

import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react';
import type { ImageRef } from '@/lib/api/types';
import { stepIndex, swipeStep } from '@/lib/carousel';

/**
 * Tallest a hero is allowed to get once its aspect ratio is honoured. Capped
 * against the viewport as well as in absolute pixels: a portrait cover at its
 * true aspect runs to ~63% of a phone screen, which pushed the event title to
 * the very bottom edge and the price below the fold — the old fixed-height hero
 * kept both in view. 48vh keeps the price above the fold on a laptop and the
 * title comfortably clear on a phone. Landscape covers never reach this cap.
 *
 * Clamping costs nothing in coverage: the photo is `object-contain`, so a
 * capped box still shows it WHOLE, just smaller and letterboxed against the
 * blurred fill.
 */
const HERO_MAX_HEIGHT = 'min(520px, 48vh)';

/** A horizontal drag shorter than this is a tap (or a wobble), not a swipe. */
const SWIPE_THRESHOLD_PX = 40;

/** CSS `object-position` for a photo's focal point (0.5/0.5 = centre crop). */
function focalPosition(img: ImageRef): string {
  return `${img.focalX * 100}% ${img.focalY * 100}%`;
}

function Chevron({ dir }: { dir: 'left' | 'right' }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {dir === 'left' ? <path d="m15 6-6 6 6 6" /> : <path d="m9 6 6 6-6 6" />}
    </svg>
  );
}

const ARROW_CLASS =
  'absolute top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-ink/60 text-white transition-colors hover:bg-ink/85 focus:outline-none focus-visible:ring-2 focus-visible:ring-white';

/**
 * Card image that renders uploaded photos. With one photo it shows it static;
 * with several it auto-crossfades every `intervalMs` (default 5s) and shows
 * dots. With none it renders `fallback` (the sport-image / motif). Visual
 * treatment (navy scrim + optional label) matches SportImage so cards look the
 * same whether the photo is uploaded or a sport fallback.
 *
 * Two variants:
 *   - `card` (default) — fixed-height `object-cover` box, cropped around each
 *     photo's focal point. Grids stay tidy because every card is the same size.
 *     Cards sit inside links and scroll rails, so they only auto-advance.
 *   - `hero` — detail-page header. When the cover photo's intrinsic size is
 *     known the box takes the cover's aspect ratio (capped at HERO_MAX_HEIGHT)
 *     and photos render `object-contain`, so a portrait poster is shown WHOLE
 *     rather than cropped through its middle. Photos in the same gallery with a
 *     different aspect letterbox against a blurred copy of the cover instead of
 *     bare bars. Photos uploaded before we captured dimensions have none, so
 *     they fall back to the fixed-height crop `className` describes. A hero
 *     with several photos is browsable: previous/next arrows, tappable dots,
 *     swipe, and the arrow keys once focused. A manual move restarts the
 *     auto-advance timer, so the next automatic change is a full interval away.
 *
 * The aspect ratio deliberately comes from the COVER only, not the current
 * slide — sizing the box per-slide would make it jump mid-crossfade.
 */
export function ImageCarousel({
  images,
  alt,
  label,
  className = '',
  intervalMs = 5000,
  fallback,
  variant = 'card',
}: {
  images: ImageRef[];
  alt: string;
  label?: string;
  className?: string;
  intervalMs?: number;
  fallback: ReactNode;
  variant?: 'card' | 'hero';
}) {
  const [idx, setIdx] = useState(0);
  const multiple = images.length > 1;
  const interactive = multiple && variant === 'hero';
  // Where a drag started; null when no drag is in progress.
  const dragStartX = useRef<number | null>(null);

  // `idx` is a dependency on purpose: every slide change (automatic or manual)
  // restarts the timer, so a swipe never gets snatched away a moment later.
  useEffect(() => {
    if (!multiple) return;
    const t = setInterval(() => setIdx((i) => stepIndex(i, images.length, 1)), intervalMs);
    return () => clearInterval(t);
  }, [multiple, images.length, intervalMs, idx]);

  if (images.length === 0) return <>{fallback}</>;

  const cover = images[0]!;
  const aspect = variant === 'hero' && cover.width && cover.height
    ? { width: cover.width, height: cover.height }
    : null;
  const contain = aspect !== null;

  const boxStyle: CSSProperties | undefined = aspect
    ? { aspectRatio: `${aspect.width} / ${aspect.height}`, maxHeight: HERO_MAX_HEIGHT }
    : undefined;

  function go(delta: -1 | 1) {
    setIdx((i) => stepIndex(i, images.length, delta));
  }

  // Swipe = pointer down, then up at least SWIPE_THRESHOLD_PX away horizontally.
  // `touch-pan-y` leaves vertical scrolling to the browser, which cancels the
  // pointer (and so the swipe) when it takes over a gesture. No pointer capture:
  // it would swallow the clicks on the arrow and dot buttons underneath.
  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    dragStartX.current = e.clientX;
  }
  function onPointerUp(e: PointerEvent<HTMLDivElement>) {
    if (dragStartX.current === null) return;
    const step = swipeStep(e.clientX - dragStartX.current, SWIPE_THRESHOLD_PX);
    dragStartX.current = null;
    if (step !== 0) go(step);
  }
  function cancelDrag() {
    dragStartX.current = null;
  }
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      go(-1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      go(1);
    }
  }

  const interactiveProps = interactive
    ? {
        role: 'region',
        'aria-roledescription': 'carousel',
        'aria-label': `${alt} photos`,
        tabIndex: 0,
        onPointerDown,
        onPointerUp,
        onPointerCancel: cancelDrag,
        onPointerLeave: cancelDrag,
        onKeyDown,
      }
    : {};

  return (
    <div
      className={`relative overflow-hidden bg-ink ${aspect ? 'w-full' : className} ${
        interactive
          ? 'touch-pan-y select-none focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/80'
          : ''
      }`}
      style={boxStyle}
      {...interactiveProps}
    >
      {/* Blurred cover fills the gaps when a contained photo doesn't match the
          box — reads as intentional depth rather than black bars. */}
      {contain && (
        <div
          aria-hidden
          className="absolute inset-0 scale-110 bg-cover bg-center opacity-50 blur-2xl"
          style={{ backgroundImage: `url(${cover.url})` }}
        />
      )}
      {images.map((img, i) => (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={img.url}
          src={img.url}
          alt={alt}
          loading="lazy"
          draggable={false}
          style={contain ? undefined : { objectPosition: focalPosition(img) }}
          className={`absolute inset-0 h-full w-full transition-opacity duration-700 ${
            contain ? 'object-contain' : 'object-cover'
          } ${i === idx ? 'opacity-100' : 'opacity-0'}`}
        />
      ))}
      {/* The scrim exists to keep `label` legible. Skip it when a contained
          photo has no label — posters carry their own text near the bottom and
          dimming it is exactly the problem this variant fixes. */}
      {(!contain || label) && (
        <div className="absolute inset-0 bg-gradient-to-t from-ink/60 to-transparent" />
      )}
      {interactive && (
        <>
          <button
            type="button"
            onClick={() => go(-1)}
            aria-label="Previous photo"
            className={`${ARROW_CLASS} left-2`}
          >
            <Chevron dir="left" />
          </button>
          <button
            type="button"
            onClick={() => go(1)}
            aria-label="Next photo"
            className={`${ARROW_CLASS} right-2`}
          >
            <Chevron dir="right" />
          </button>
        </>
      )}
      {multiple && (
        <div className="absolute bottom-2 right-2 flex gap-1">
          {images.map((img, i) => {
            const dot = (
              <span
                className={`block h-1.5 w-1.5 rounded-full transition-colors ${
                  i === idx ? 'bg-white' : 'bg-white/40'
                }`}
              />
            );
            return interactive ? (
              <button
                key={img.url}
                type="button"
                onClick={() => setIdx(i)}
                aria-label={`Photo ${i + 1} of ${images.length}`}
                aria-current={i === idx ? 'true' : undefined}
                className="flex h-5 w-5 items-center justify-center rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
              >
                {dot}
              </button>
            ) : (
              <span key={img.url} className="flex h-1.5 w-1.5">
                {dot}
              </span>
            );
          })}
        </div>
      )}
      {label && (
        <span className="absolute bottom-2.5 left-3 text-[11px] font-bold uppercase tracking-wider text-white">
          {label}
        </span>
      )}
    </div>
  );
}
