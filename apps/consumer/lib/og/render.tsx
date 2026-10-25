import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ImageResponse } from 'next/og';
import type { ListingCard } from './listing_card';

/** The size WhatsApp, iMessage and the rest show as a large card (1.91:1). */
export const OG_SIZE = { width: 1200, height: 630 };

// Brand tokens from app/globals.css; the image renderer can't read CSS variables.
const INK = '#17151D';
const INK_SOFT = '#4a4654';
const SURFACE = '#FAF3E8';
const CORAL = '#F77E54';
const CORAL_DEEP = '#EE5C2B';
const CORAL_SOFT = '#FBE3D6';

const PHOTO_WIDTH = 480;

type Font = { name: string; data: ArrayBuffer; weight: 600 | 800; style: 'normal' };

/**
 * The brand faces as TrueType, which is all the image renderer reads (the
 * site's own copies are woff2). Fetched from Google Fonts once per server
 * process; if that fails, the card falls back to the renderer's built-in
 * face rather than not rendering at all.
 */
let fonts: Promise<Font[]> | null = null;

async function googleFont(family: string, weight: 600 | 800): Promise<Font> {
  // Without a browser user agent Google serves TrueType rather than woff2.
  const css = await (
    await fetch(`https://fonts.googleapis.com/css2?family=${family.replace(/ /g, '+')}:wght@${weight}`)
  ).text();
  const url = /src: url\(([^)]+)\) format\('(?:truetype|opentype)'\)/.exec(css)?.[1];
  if (!url) throw new Error(`no TrueType source for ${family}`);
  const data = await (await fetch(url)).arrayBuffer();
  return { name: family, data, weight, style: 'normal' };
}

function loadFonts(): Promise<Font[]> {
  fonts ??= Promise.all([googleFont('Bricolage Grotesque', 800), googleFont('Plus Jakarta Sans', 600)]).catch(() => {
    fonts = null; // try again on the next card
    return [];
  });
  return fonts;
}

/** What the image renderer can draw. Uploads may also be WebP, which it can't. */
const DRAWABLE: Record<string, string> = { 'image/jpeg': 'jpeg', 'image/png': 'png', jpg: 'jpeg', jpeg: 'jpeg', png: 'png' };

/**
 * A picture as a data URL, or null when it can't be drawn: missing, slow,
 * too big, or in a format the renderer can't read. Site paths (the sport
 * photos, the logo) are read from the site's own `public/` folder rather
 * than fetched, so the server never depends on reaching its own public
 * address. Next runs the server from the app's folder, here and in the
 * standalone build.
 */
async function loadPicture(src: string): Promise<string | null> {
  try {
    if (src.startsWith('/')) {
      const type = DRAWABLE[src.split('.').pop()?.toLowerCase() ?? ''];
      if (!type) return null;
      const data = await readFile(join(process.cwd(), 'public', src));
      return `data:image/${type};base64,${data.toString('base64')}`;
    }
    const res = await fetch(src, { signal: AbortSignal.timeout(4000) });
    const type = DRAWABLE[res.headers.get('content-type')?.split(';')[0]?.trim() ?? ''];
    if (!res.ok || !type) return null;
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length > 8_000_000) return null;
    return `data:image/${type};base64,${data.toString('base64')}`;
  } catch {
    return null;
  }
}

/** The first of `sources` that can be drawn. */
async function firstPicture(sources: string[]): Promise<string | null> {
  for (const src of sources) {
    const picture = await loadPicture(src);
    if (picture) return picture;
  }
  return null;
}

/**
 * The rendered card as a JPEG. The renderer only writes PNG, and a PNG with a
 * photo in it runs to ~800 KB, past what WhatsApp will show as a preview
 * (~300 KB); the same card as a JPEG is a fraction of that. If sharp can't
 * load, the PNG goes out as it is.
 */
async function asJpeg(png: ImageResponse): Promise<Response> {
  const bytes = Buffer.from(await png.arrayBuffer());
  const headers = { 'Cache-Control': 'public, max-age=300' };
  try {
    const { default: sharp } = await import('sharp');
    const jpeg = await sharp(bytes).jpeg({ quality: 82, mozjpeg: true }).toBuffer();
    return new Response(new Uint8Array(jpeg), { headers: { ...headers, 'Content-Type': 'image/jpeg' } });
  } catch {
    return new Response(new Uint8Array(bytes), { headers: { ...headers, 'Content-Type': 'image/png' } });
  }
}

/** Shorter titles get bigger type; very long ones are cut. */
function titleStyle(title: string): { text: string; fontSize: number } {
  const text = title.length > 70 ? `${title.slice(0, 68).trimEnd()}…` : title;
  return { text, fontSize: text.length > 44 ? 52 : text.length > 24 ? 62 : 72 };
}

/**
 * The share image for a listing: the photo on the left, and on the right the
 * kind, the name, when/where, and where to book, in the site's ink-and-cream
 * style. With no photo the left side carries the petal mark instead; with no
 * listing (a draft, a removed one) the card is the plain brand card.
 */
export async function renderListingCard(card: ListingCard | null, origin: string): Promise<Response> {
  const [loaded, logo, photo] = await Promise.all([
    loadFonts(),
    loadPicture('/email-logo.png'),
    firstPicture(card?.pictures ?? []),
  ]);
  const display = loaded.length ? 'Bricolage Grotesque' : undefined;
  const body = loaded.length ? 'Plus Jakarta Sans' : undefined;
  const host = new URL(origin).host;
  const title = titleStyle(card?.title ?? 'Find your circle. Book your spot.');

  const png = new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', background: SURFACE, fontFamily: body, color: INK }}>
        <div
          style={{
            width: PHOTO_WIDTH,
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: CORAL_SOFT,
            borderRight: `6px solid ${INK}`,
          }}
        >
          {photo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={photo} width={PHOTO_WIDTH} height={OG_SIZE.height} style={{ objectFit: 'cover' }} alt="" />
          ) : logo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logo} width={280} height={280} alt="" />
          ) : null}
        </div>
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            padding: '52px 56px 56px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center' }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {logo && <img src={logo} width={52} height={52} alt="" style={{ marginRight: 14 }} />}
            <div style={{ fontFamily: display, fontWeight: 800, fontSize: 38 }}>circls</div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {card && (
              <div style={{ fontSize: 24, fontWeight: 600, letterSpacing: 3, color: CORAL_DEEP, textTransform: 'uppercase' }}>
                {card.kind}
              </div>
            )}
            <div
              style={{ marginTop: 10, fontFamily: display, fontWeight: 800, fontSize: title.fontSize, lineHeight: 1.05 }}
            >
              {title.text}
            </div>
            {(card?.lines ?? []).map((line) => (
              <div key={line} style={{ marginTop: 16, fontSize: 32, fontWeight: 600, color: INK_SOFT }}>
                {line}
              </div>
            ))}
          </div>
          <div style={{ display: 'flex' }}>
            <div
              style={{
                display: 'flex',
                padding: '14px 28px',
                background: CORAL,
                border: `3px solid ${INK}`,
                borderRadius: 16,
                boxShadow: `6px 6px 0 ${INK}`,
                fontSize: 28,
                fontWeight: 600,
              }}
            >
              {card ? `Book on ${host}` : host}
            </div>
          </div>
        </div>
      </div>
    ),
    { ...OG_SIZE, ...(loaded.length ? { fonts: loaded } : {}) },
  );
  return asJpeg(png);
}
