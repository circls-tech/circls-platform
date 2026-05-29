import { LegalLayout } from '@/components/legal/LegalLayout';
import { TERMS } from '@/lib/legal/terms';

export const metadata = { title: 'Terms & Conditions — circls' };
export default function TermsPage() { return <LegalLayout doc={TERMS} />; }
