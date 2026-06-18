import { forwardRef, InputHTMLAttributes, useId } from 'react';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
  error?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, hint, error, id: idProp, className = '', ...rest },
  ref,
) {
  const generatedId = useId();
  const id = idProp ?? generatedId;

  return (
    <div className="flex flex-col gap-1.5">
      {label != null && (
        <label
          htmlFor={id}
          className="font-display text-xs font-bold uppercase tracking-wide text-ink"
        >
          {label}
        </label>
      )}
      <input
        ref={ref}
        id={id}
        className={[
          'w-full rounded-[var(--radius)] border-[2.5px] px-3.5 py-2.5 text-sm',
          'text-ink placeholder:text-text-muted',
          'transition-colors duration-150 focus:outline-none',
          error
            ? 'border-petal-red bg-coral-soft/40'
            : 'border-ink bg-white focus:border-coral-deep',
          className,
        ].join(' ')}
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        aria-invalid={error ? true : undefined}
        {...rest}
      />
      {error != null && (
        <p id={`${id}-error`} className="text-xs font-semibold text-petal-red">
          {error}
        </p>
      )}
      {hint != null && error == null && (
        <p id={`${id}-hint`} className="text-xs text-text-muted">
          {hint}
        </p>
      )}
    </div>
  );
});
