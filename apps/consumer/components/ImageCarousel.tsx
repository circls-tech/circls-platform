'use client';

import {
  type CSSProperties,
  type FocusEvent,
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

/**
 * Focus treatment for the hero's controls. The `!` variants matter: globals.css
 * has an unlayered `*:focus-visible` rule (coral outline + 14px radius) that
 * beats Tailwind's layered utilities, so without them a focused arrow shows two
 * outlines and loses its circle.
 */
const FOCUS_CLASS = 'focus:outline-none! focus-visible:ring-2 focus-visible:ring-white';

/** CSS `object-position` for a photo's focal point (0.5/0.5 = centre crop). */
function focalPosition(img: ImageRef): string {
  return `${img.focalX * 100}% ${img.focalY * 100}%`;
}

function ArrowButton({ dir, onClick }: { dir: 'left' | 'right'; onClick: () => void }) {
  const left = dir === 'left';
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={left ? 'Previous photo' : 'Next photo'}
      className={`absolute top-1/2 ${left ? 'left-2' : 'right-2'} flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full! bg-ink/60 text-white transition-colors hover:bg-ink/85 ${FOCUS_CLASS}`}
    >
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
        <path d={left ? 'm15 6-6 6 6 6' : 'm9 6 6 6-6 6'} />
      </svg>
    </button>
  );
}

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
 *     swipe, and the arrow keys once focused.
 *
 * Auto-advance pauses while the user is on the gallery (mouse hover, keyboard
 * focus, a drag in progress) and when they prefer reduced motion; any manual
 * move re-arms it for a full interval, so a swipe is never undone a moment
 * later.
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
  // Bumped by manual moves that leave `idx` unchanged (tapping the current
  // dot) so the auto-advance timer still restarts.
  const [restart, setRestart] = useState(0);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dragging, setDragging] = useState(false);
  // The pointer that started a swipe; null when no drag is in progress.
  const drag = useRef<{ pointerId: number; startX: number } | null>(null);

  const multiple = images.length > 1;
  const interactive = multiple && variant === 'hero';
  const paused = hovered || focused || dragging;
  // `idx` can outlive a gallery that shrank under it (a refetch after the
  // partner deleted photos); show the cover rather than nothing.
  const current = idx < images.length ? idx : 0;

  // One timeout per slide: every change (automatic or manual) re-arms it, so
  // the next automatic move is always a full interval away.
  useEffect(() => {
    if (!multiple || paused) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const t = setTimeout(
      () => setIdx((i) => stepIndex(i < images.length ? i : 0, images.length, 1)),
      intervalMs,
    );
    return () => clearTimeout(t);
  }, [multiple, paused, images.length, intervalMs, idx, restart]);

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
    setIdx((i) => stepIndex(i < images.length ? i : 0, images.length, delta));
  }
  function select(i: number) {
    setIdx(i);
    setRestart((n) => n + 1);
  }

  // Swipe = primary pointer down, then up at least SWIPE_THRESHOLD_PX away
  // horizontally. `touch-pan-y touch-pinch-zoom` leaves vertical scrolling and
  // pinching to the browser, which cancels the pointer (and so the swipe) when
  // it takes over a gesture. No pointer capture: it would swallow the clicks on
  // the arrow and dot buttons underneath.
  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    if (!e.isPrimary || e.button !== 0) return;
    drag.current = { pointerId: e.pointerId, startX: e.clientX };
    setDragging(true);
  }
  function onPointerUp(e: PointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    drag.current = null;
    setDragging(false);
    const step = swipeStep(e.clientX - d.startX, SWIPE_THRESHOLD_PX);
    if (step !== 0) go(step);
  }
  function cancelDrag() {
    drag.current = null;
    setDragging(false);
  }
  function onPointerEnter(e: PointerEvent<HTMLDivElement>) {
    if (e.pointerType === 'mouse') setHovered(true);
  }
  function onPointerLeave(e: PointerEvent<HTMLDivElement>) {
    cancelDrag();
    if (e.pointerType === 'mouse') setHovered(false);
  }
  function onBlur(e: FocusEvent<HTMLDivElement>) {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
  }
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    // Leave browser shortcuts (Alt/Cmd+Left = Back) alone.
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
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
        onPointerEnter,
        onPointerLeave,
        onFocus: () => setFocused(true),
        onBlur,
        onKeyDown,
      }
    : {};

  return (
    <div
      className={`relative overflow-hidden bg-ink ${aspect ? 'w-full' : className} ${
        interactive
          ? `touch-pan-y touch-pinch-zoom select-none rounded-none! ${FOCUS_CLASS} focus-visible:ring-inset focus-visible:ring-white/80`
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
          alt={multiple ? `${alt} (photo ${i + 1} of ${images.length})` : alt}
          // Faded-out slides are still in the accessibility tree; hide them so
          // a screen reader hears one photo, not the whole stack.
          aria-hidden={i !== current}
          loading="lazy"
          draggable={false}
          style={contain ? undefined : { objectPosition: focalPosition(img) }}
          className={`absolute inset-0 h-full w-full transition-opacity duration-700 ${
            contain ? 'object-contain' : 'object-cover'
          } ${i === current ? 'opacity-100' : 'opacity-0'}`}
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
          <ArrowButton dir="left" onClick={() => go(-1)} />
          <ArrowButton dir="right" onClick={() => go(1)} />
        </>
      )}
      {multiple && (
        // Interactive dots are bigger, so the row may wrap on phones rather
        // than run into the label in the opposite corner.
        <div
          className={`absolute bottom-2 right-2 flex gap-1 ${
            interactive ? 'max-w-[60%] flex-wrap justify-end' : ''
          }`}
        >
          {images.map((img, i) => {
            const dotClass = `block h-1.5 w-1.5 rounded-full transition-colors ${
              i === current ? 'bg-white' : 'bg-white/40'
            }`;
            return interactive ? (
              // Not a tab stop: the region's arrow keys are the keyboard path,
              // so a 12-photo hero doesn't cost 12 extra Tabs.
              <button
                key={img.url}
                type="button"
                tabIndex={-1}
                onClick={() => select(i)}
                aria-label={`Photo ${i + 1} of ${images.length}`}
                aria-current={i === current ? 'true' : undefined}
                className={`flex h-4 w-4 items-center justify-center rounded-full! ${FOCUS_CLASS}`}
              >
                <span className={dotClass} />
              </button>
            ) : (
              <span key={img.url} className={dotClass} />
            );
          })}
        </div>
      )}
      {label && (
        <span className="pointer-events-none absolute bottom-2.5 left-3 text-[11px] font-bold uppercase tracking-wider text-white">
          {label}
        </span>
      )}
    </div>
  );
}
