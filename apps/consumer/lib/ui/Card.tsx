import { HTMLAttributes, ReactNode } from 'react';

export interface CardProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  title?: ReactNode;
  subtitle?: ReactNode;
  children?: ReactNode;
  className?: string;
}

export function Card({ title, subtitle, children, className = '', ...rest }: CardProps) {
  const hasHeader = title != null || subtitle != null;
  return (
    <div
      className={[
        'rounded-card border border-border bg-white shadow-sm',
        className,
      ].join(' ')}
      {...rest}
    >
      {hasHeader && (
        <div className="border-b border-border px-6 py-4">
          {title != null && (
            <h2 className="text-base font-semibold text-text-primary">{title}</h2>
          )}
          {subtitle != null && (
            <p className="mt-0.5 text-sm text-text-secondary">{subtitle}</p>
          )}
        </div>
      )}
      <div className="p-6">{children}</div>
    </div>
  );
}
