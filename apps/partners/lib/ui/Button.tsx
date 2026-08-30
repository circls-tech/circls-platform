import { ButtonHTMLAttributes, forwardRef } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  /** Petal pastel fill (hex). Renders the comic ink-border/offset-shadow look;
   *  applied via inline style because variant classes would win the cascade. */
  petal?: string;
}

// Fill and text only. The border and shadow come from the raised treatment
// below, so a variant can't fight it over which border colour wins.
const variantClasses: Record<ButtonVariant, string> = {
  primary: 'bg-brand-600 text-slate-900 hover:bg-brand-700',
  secondary: 'bg-white text-slate-700 hover:bg-slate-50',
  ghost: 'bg-transparent text-slate-600 border border-transparent hover:bg-slate-100',
  danger: 'bg-red-600 text-white hover:bg-red-700',
};

/**
 * The portal's raised look: ink border, hard offset shadow, and a lift on
 * hover that presses back in on click.
 *
 * Petal buttons always had it; the plain variants didn't, so a Secondary
 * button read as an inert tile rather than something you press. Ghost is
 * deliberately left flat — it is a text-weight action, and a raised
 * transparent button looks like a mistake.
 */
const RAISED = [
  'border-2 border-[#17151D] shadow-[3px_3px_0_#17151D]',
  'transition-transform hover:-translate-y-0.5',
  'active:translate-y-0 active:shadow-[1px_1px_0_#17151D]',
  // A button you can't press shouldn't look like it stands up.
  'disabled:translate-y-0 disabled:shadow-none',
].join(' ');

const sizeClasses: Record<ButtonSize, string> = {
  sm: 'px-3 py-1.5 text-xs',
  md: 'px-4 py-2 text-sm',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'primary',
    size = 'md',
    loading = false,
    disabled,
    children,
    className = '',
    type = 'button',
    petal,
    style,
    ...rest
  },
  ref,
) {
  const isDisabled = disabled || loading;
  return (
    <button
      ref={ref}
      type={type}
      disabled={isDisabled}
      className={[
        'inline-flex items-center justify-center gap-2 rounded-[var(--radius)]',
        'font-medium transition-colors duration-150',
        'disabled:cursor-not-allowed disabled:opacity-50',
        variantClasses[variant],
        sizeClasses[size],
        // Petal keeps its bolder ink text; everything but ghost is raised.
        petal ? `${RAISED} font-bold text-[#17151D]` : variant === 'ghost' ? '' : RAISED,
        className,
      ].join(' ')}
      style={petal ? { backgroundColor: petal, borderColor: '#17151D', ...style } : style}
      {...rest}
    >
      {loading && (
        <span className="block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
      )}
      {children}
    </button>
  );
});
