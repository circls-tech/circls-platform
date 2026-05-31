'use client';

import { type ReactNode, useEffect, useState } from 'react';
import type { ImageRef } from '@/lib/api/types';

/**
 * Card image that renders uploaded photos. With one photo it shows it static;
 * with several it auto-crossfades every `intervalMs` (default 5s) and shows
 * dots. With none it renders `fallback` (the sport-image / motif). Visual
 * treatment (navy scrim + optional label) matches SportImage so cards look the
 * same whether the photo is uploaded or a sport fallback.
 */
export function ImageCarousel({
  images,
  alt,
  label,
  className = '',
  intervalMs = 5000,
  fallback,
}: {
  images: ImageRef[];
  alt: string;
  label?: string;
  className?: string;
  intervalMs?: number;
  fallback: ReactNode;
}) {
  const [idx, setIdx] = useState(0);
  const multiple = images.length > 1;

  useEffect(() => {
    if (!multiple) return;
    const t = setInterval(() => setIdx((i) => (i + 1) % images.length), intervalMs);
    return () => clearInterval(t);
  }, [multiple, images.length, intervalMs]);

  if (images.length === 0) return <>{fallback}</>;

  return (
    <div className={`relative overflow-hidden bg-ink ${className}`}>
      {images.map((img, i) => (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={img.url}
          src={img.url}
          alt={alt}
          loading="lazy"
          className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-700 ${
            i === idx ? 'opacity-100' : 'opacity-0'
          }`}
        />
      ))}
      <div className="absolute inset-0 bg-gradient-to-t from-ink/60 to-transparent" />
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
