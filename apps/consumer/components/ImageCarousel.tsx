'use client';

import { type CSSProperties, type ReactNode, useEffect, useState } from 'react';
import type { ImageRef } from '@/lib/api/types';

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

/** CSS `object-position` for a photo's focal point (0.5/0.5 = centre crop). */
function focalPosition(img: ImageRef): string {
  return `${img.focalX * 100}% ${img.focalY * 100}%`;
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
 *   - `hero` — detail-page header. When the cover photo's intrinsic size is
 *     known the box takes the cover's aspect ratio (capped at HERO_MAX_HEIGHT)
 *     and photos render `object-contain`, so a portrait poster is shown WHOLE
 *     rather than cropped through its middle. Photos in the same gallery with a
 *     different aspect letterbox against a blurred copy of the cover instead of
 *     bare bars. Photos uploaded before we captured dimensions have none, so
 *     they fall back to the fixed-height crop `className` describes.
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

  useEffect(() => {
    if (!multiple) return;
    const t = setInterval(() => setIdx((i) => (i + 1) % images.length), intervalMs);
    return () => clearInterval(t);
  }, [multiple, images.length, intervalMs]);

  if (images.length === 0) return <>{fallback}</>;

  const cover = images[0]!;
  const aspect = variant === 'hero' && cover.width && cover.height
    ? { width: cover.width, height: cover.height }
    : null;
  const contain = aspect !== null;

  const boxStyle: CSSProperties | undefined = aspect
    ? { aspectRatio: `${aspect.width} / ${aspect.height}`, maxHeight: HERO_MAX_HEIGHT }
    : undefined;

  return (
    <div
      className={`relative overflow-hidden bg-ink ${aspect ? 'w-full' : className}`}
      style={boxStyle}
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
      {multiple && (
        <div className="absolute bottom-2 right-2 flex gap-1">
          {images.map((img, i) => (
            <span
              key={img.url}
              className={`h-1.5 w-1.5 rounded-full transition-colors ${
                i === idx ? 'bg-white' : 'bg-white/40'
              }`}
            />
          ))}
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
