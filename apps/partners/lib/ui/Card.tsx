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
        'rounded-[var(--radius)] border-2 border-[#17151D] bg-white shadow-[4px_4px_0_#17151D]',
        className,
      ].join(' ')}
      {...rest}
    >
      {hasHeader && (
        <div className="border-b-2 border-[#17151D] px-5 py-3">
          {title != null && (
            <h2 className="font-[family-name:var(--font-display)] text-base font-bold text-[#17151D]">{title}</h2>
          )}
          {subtitle != null && (
            <p className="mt-0.5 text-sm text-[#475569]">{subtitle}</p>
          )}
        </div>
      )}
      <div className="p-5">{children}</div>
    </div>
  );
}
