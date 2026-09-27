import { Card } from '@/lib/ui';

/** Stands in for a form or page the signed-in member's role can't use. */
export function RoleNotice({ children }: { children: React.ReactNode }) {
  return (
    <Card>
      <p className="py-2 text-sm text-slate-600">{children}</p>
    </Card>
  );
}
