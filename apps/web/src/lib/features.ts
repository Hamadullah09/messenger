'use client';

import { FEATURE_KEYS, type FeaturesDto } from '@storeline/shared';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { useAuth } from './auth-store';

const ALL_ON = Object.fromEntries(FEATURE_KEYS.map((k) => [k, true])) as FeaturesDto;

/** Which parts of the app the Super Admin left on (everything is on until the answer arrives). */
export function useFeatures(): FeaturesDto {
  const signedIn = useAuth((s) => s.status === 'signed-in');
  const query = useQuery({
    queryKey: ['features'],
    queryFn: () => api<FeaturesDto>('/features'),
    enabled: signedIn,
    staleTime: 60_000,
  });
  return query.data ?? ALL_ON;
}
