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
        'rounded-[var(--radius)] border border-[#e5e7eb] bg-white shadow-sm',
        className,
      ].join(' ')}
      {...rest}
    >
      {hasHeader && (
        <div className="border-b border-[#e5e7eb] px-6 py-4">
          {title != null && (
            <h2 className="text-base font-semibold text-[#0f172a]">{title}</h2>
          )}
          {subtitle != null && (
            <p className="mt-0.5 text-sm text-[#475569]">{subtitle}</p>
          )}
        </div>
      )}
      <div className="p-6">{children}</div>
    </div>
  );
}
