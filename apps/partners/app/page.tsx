import { redirect } from 'next/navigation';

export default function Home() {
  redirect('/dashboard'); // protected layout bounces to /login if not signed in
}
