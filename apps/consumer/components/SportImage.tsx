import { resolveImage, type ResolveImageInput } from '@/lib/sportImages';

const MOTIF_GRID: React.CSSProperties = {
  backgroundImage:
    'linear-gradient(var(--color-coral) 2px, transparent 2px), linear-gradient(90deg, var(--color-coral) 2px, transparent 2px)',
  backgroundSize: '30px 30px',
};

/** Venue/event/membership image header. Renders the resolved photo with a navy
 *  scrim + sport label, or the court-line motif when no photo is available. */
export function SportImage({
  input,
  alt,
  label,
  className = '',
}: {
  input: ResolveImageInput;
  alt: string;
  label?: string;
  className?: string;
}) {
  const r = resolveImage(input);
  const isMotif = r.kind === 'motif';
  return (
    <div
      className={`relative overflow-hidden bg-ink ${className}`}
      role={isMotif ? 'img' : undefined}
      aria-label={isMotif ? alt : undefined}
    >
      {r.kind === 'photo' ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={r.src} alt={alt} loading="lazy" className="h-full w-full object-cover" />
          <div className="absolute inset-0 bg-gradient-to-t from-ink/60 to-transparent" />
        </>
      ) : (
        <>
          <div className="absolute inset-0 opacity-[0.16]" style={MOTIF_GRID} />
          <div className="absolute inset-4 rounded-md border-2 border-coral/60" />
        </>
      )}
      {label && (
        <span className="absolute bottom-2.5 left-3 text-[11px] font-bold uppercase tracking-wider text-white">
          {label}
        </span>
      )}
    </div>
  );
}
