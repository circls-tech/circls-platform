import { forwardRef, InputHTMLAttributes, ReactNode, useId } from 'react';

/** Label treatment shared by every form field. */
export const LABEL_CLASS = 'font-display text-xs font-bold uppercase tracking-wide text-ink';

/**
 * aria wiring for the control inside a Field: describedby points at the error
 * while there is one, else at the hint, and invalid follows the error.
 */
export function fieldAria(id: string, error?: string, hint?: string) {
  return {
    'aria-describedby': error ? `${id}-error` : hint ? `${id}-hint` : undefined,
    'aria-invalid': error ? true : undefined,
  } as const;
}

/**
 * Label / error / hint chrome around any form control, so a <select> or a
 * checkbox group reads exactly like an Input. `id` is the control's id; the
 * label is `${id}-label` so a group can point at it with aria-labelledby (set
 * `group` to skip `htmlFor`, which only labelable elements accept).
 */
export function Field({
  id,
  label,
  hint,
  error,
  group = false,
  children,
}: {
  id: string;
  label?: string;
  hint?: string;
  error?: string;
  group?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      {label != null && (
        <label id={`${id}-label`} htmlFor={group ? undefined : id} className={LABEL_CLASS}>
          {label}
        </label>
      )}
      {children}
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
}

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
    <Field id={id} label={label} hint={hint} error={error}>
      <input
        ref={ref}
        id={id}
        className={[
          'w-full rounded-[var(--radius)] border-[2px] px-3.5 py-2.5 text-sm',
          'text-ink placeholder:text-text-muted',
          'transition-colors duration-150 focus:outline-none',
          error
            ? 'border-petal-red bg-coral-soft/40'
            : 'border-ink bg-white focus:border-coral-deep',
          className,
        ].join(' ')}
        {...fieldAria(id, error, hint)}
        {...rest}
      />
    </Field>
  );
});
