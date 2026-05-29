import { LegalLayout } from '@/components/legal/LegalLayout';
import { PRIVACY } from '@/lib/legal/privacy';

export const metadata = { title: 'Privacy Policy — Circls' };
export default function PrivacyPage() { return <LegalLayout doc={PRIVACY} />; }
