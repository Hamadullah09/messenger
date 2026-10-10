'use client';

import type { MediaAssetDto, MediaUrlDto } from '@storeline/shared';
import { useQuery } from '@tanstack/react-query';
import { create } from 'zustand';
import { api } from './api';

/** Latest media status pushed by the server (uploader only). */
export const useMediaStatus = create<{
  byId: Record<string, MediaAssetDto>;
  set: (media: MediaAssetDto) => void;
}>((set) => ({
  byId: {},
  set: (media) => set((state) => ({ byId: { ...state.byId, [media.id]: media } })),
}));

/**
 * Short-lived download URL for a file. URLs are requested on demand (never stored in
 * messages) and refreshed before they expire.
 */
export function useMediaUrl(mediaId: string, variant: 'original' | 'thumbnail', enabled = true) {
  return useQuery({
    queryKey: ['media-url', mediaId, variant],
    queryFn: () => api<MediaUrlDto>(`/media/${mediaId}/url`, { query: { variant } }),
    enabled,
    staleTime: 60_000,
    gcTime: 4 * 60_000,
    refetchInterval: (query) => {
      const expiresAt = query.state.data ? Date.parse(query.state.data.expiresAt) : 0;
      return expiresAt ? Math.max(30_000, expiresAt - Date.now() - 60_000) : false;
    },
  });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
