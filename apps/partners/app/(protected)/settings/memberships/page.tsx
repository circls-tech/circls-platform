import { redirect } from 'next/navigation';

// Memberships moved to a top-level tab. Keep this redirect for any bookmarks.
export default function SettingsMembershipsRedirect() {
  redirect('/memberships');
}
