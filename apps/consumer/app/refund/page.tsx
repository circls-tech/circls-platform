import { LegalLayout } from '@/components/legal/LegalLayout';
import { REFUND } from '@/lib/legal/refund';

export const metadata = { title: 'Refund Policy — Circls' };
export default function RefundPage() { return <LegalLayout doc={REFUND} />; }
