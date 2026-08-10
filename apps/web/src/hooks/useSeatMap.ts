import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Reservation, SeatMap } from '@lumen/shared';
import { api } from '../api/client';

/** How often we re-read the map so other people's seats appear without a refresh. */
const POLL_MS = 4000;

export const seatMapKey = (screeningId: number | null) => ['seatMap', screeningId] as const;
export const reservationsKey = (screeningId: number | null) =>
  ['reservations', screeningId] as const;

export interface SeatMapState {
  seatMap: SeatMap | null;
  reservations: Reservation[];
  loading: boolean;
  stale: boolean;
  /** Re-read immediately, e.g. straight after holding or confirming. */
  refresh: () => Promise<void>;
}

/**
 * Keeps one screening's seat map and the viewer's own reservations current.
 *
 * Polling, pausing in a background tab, refetching on focus, discarding responses for a
 * screening the user has navigated away from, and de-duplicating in-flight requests are all
 * React Query behaviour rather than code we maintain. Keying the queries by screening id is
 * what makes the stale-response problem disappear: a late reply lands in the cache entry it
 * belongs to and is simply not the one being rendered.
 */
export function useSeatMap(screeningId: number | null): SeatMapState {
  const queryClient = useQueryClient();
  const enabled = screeningId !== null;

  const seatMap = useQuery({
    queryKey: seatMapKey(screeningId),
    queryFn: () => api.seatMap(screeningId as number),
    enabled,
    refetchInterval: POLL_MS,
  });

  const reservations = useQuery({
    queryKey: reservationsKey(screeningId),
    queryFn: () => api.myReservations(screeningId as number).then((result) => result.reservations),
    enabled,
    refetchInterval: POLL_MS,
  });

  const refresh = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: seatMapKey(screeningId) }),
      queryClient.invalidateQueries({ queryKey: reservationsKey(screeningId) }),
    ]);
  }, [queryClient, screeningId]);

  return {
    seatMap: seatMap.data ?? null,
    reservations: reservations.data ?? [],
    loading: enabled && seatMap.isPending,
    // Showing the last known map while retries run beats blanking the screen.
    stale: seatMap.isError || reservations.isError,
    refresh,
  };
}
