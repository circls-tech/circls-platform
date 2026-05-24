import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/lib/firebase/auth_context';
import { apiFetch } from './client';
import type { User } from './types';

export function useMe() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['me', user?.uid],
    enabled: Boolean(user),
    queryFn: () => apiFetch<User>('/v1/me'),
  });
}
