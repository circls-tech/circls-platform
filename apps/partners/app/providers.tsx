'use client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { AuthProvider } from '@/lib/firebase/auth_context';
import { TimezoneProvider } from '@/lib/timezone_context';

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: 1 } } }),
  );
  return (
    <QueryClientProvider client={client}>
      <TimezoneProvider>
        <AuthProvider>{children}</AuthProvider>
      </TimezoneProvider>
    </QueryClientProvider>
  );
}
