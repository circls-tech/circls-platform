import { ButtonHTMLAttributes, forwardRef } from 'react';

export type ButtonVariant = 'primary' | 'accent' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}

// Signature style: 2.5px ink border + hard offset shadow that grows on hover
// and presses flat on click.
const variantClasses: Record<ButtonVariant, string> = {
  primary:   'bg-coral text-ink border-ink shadow-offset-sm hover:bg-coral-deep',
  accent:    'bg-lav text-ink border-ink shadow-offset-sm hover:bg-lav-soft',
  secondary: 'bg-white text-ink border-ink shadow-offset-sm hover:bg-surface-2',
  ghost:     'bg-transparent text-ink border-transparent shadow-none hover:bg-surface-2',
  danger:    'bg-petal-red text-white border-ink shadow-offset-sm hover:brightness-95',
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: 'px-3.5 py-1.5 text-xs',
  md: 'px-5 py-2.5 text-sm',
};

const LIFT =
  'hover:-translate-x-0.5 hover:-translate-y-0.5 hover:shadow-offset ' +
  'active:translate-x-0 active:translate-y-0 active:shadow-none';

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'primary',
    size = 'md',
    loading = false,
    disabled,
    children,
    className = '',
    type = 'button',
    ...rest
  },
  ref,
) {
  const isDisabled = disabled || loading;
  const interactive = variant === 'ghost' ? '' : LIFT;
  return (
    <button
      ref={ref}
      type={type}
      disabled={isDisabled}
      className={[
        'inline-flex items-center justify-center gap-2 rounded-[var(--radius)]',
        'border-[2.5px] font-display font-bold transition-[transform,box-shadow,background-color] duration-100',
        'disabled:cursor-not-allowed disabled:opacity-50 disabled:translate-x-0 disabled:translate-y-0',
        variantClasses[variant],
        interactive,
        sizeClasses[size],
        className,
      ].join(' ')}
      {...rest}
    >
      {loading && (
        <span className="block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
      )}
      {children}
    </button>
  );
});
