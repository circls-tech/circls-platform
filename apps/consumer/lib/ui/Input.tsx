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
    <div className="flex flex-col gap-1">
      {label != null && (
        <label
          htmlFor={id}
          className="text-xs font-medium uppercase tracking-wide text-text-secondary"
        >
          {label}
        </label>
      )}
      <input
        ref={ref}
        id={id}
        className={[
          'w-full rounded-[var(--radius)] border px-3 py-2 text-sm',
          'text-[#0f172a] placeholder:text-[#94a3b8]',
          'transition-colors duration-150',
          error
            ? 'border-red-400 bg-red-50'
            : 'border-border bg-white hover:border-gold-500',
          className,
        ].join(' ')}
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        aria-invalid={error ? true : undefined}
        {...rest}
      />
      {error != null && (
        <p id={`${id}-error`} className="text-xs text-red-600">
          {error}
        </p>
      )}
      {hint != null && error == null && (
        <p id={`${id}-hint`} className="text-xs text-[#94a3b8]">
          {hint}
        </p>
      )}
    </div>
  );
});
