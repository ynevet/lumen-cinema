import { useCallback, useEffect, useRef, useState } from 'react';
import type { Reservation, SeatMap } from '@lumen/shared';
import { ApiError, api } from '../api/client';

/** How often we re-read the map so other people's seats appear without a refresh. */
const POLL_MS = 4000;

export interface SeatMapState {
  seatMap: SeatMap | null;
  reservations: Reservation[];
  loading: boolean;
  error: string | null;
  /** Re-read immediately, e.g. straight after holding or confirming. */
  refresh: () => Promise<void>;
}

/**
 * Keeps one screening's seat map and the viewer's own reservations current.
 *
 * Polls while the tab is visible and re-reads the moment it regains focus. Responses for a
 * screening the user has since navigated away from are discarded rather than applied.
 */
export function useSeatMap(screeningId: number | null): SeatMapState {
  const [seatMap, setSeatMap] = useState<SeatMap | null>(null);
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Which screening the UI is actually showing, so late responses can be ignored.
  const showing = useRef<number | null>(null);
  showing.current = screeningId;

  const refresh = useCallback(async () => {
    if (screeningId === null) return;
    const [map, mine] = await Promise.all([
      api.seatMap(screeningId),
      api.myReservations(screeningId),
    ]);
    if (showing.current !== screeningId) return;
    setSeatMap(map);
    setReservations(mine.reservations);
  }, [screeningId]);

  useEffect(() => {
    if (screeningId === null) return;
    let cancelled = false;

    // `force` covers the first load and regaining focus, so a tab that starts in the
    // background still fills in rather than spinning forever.
    const tick = async (force = false): Promise<void> => {
      if (document.hidden && !force) return;
      try {
        await refresh();
        if (!cancelled) setError(null);
      } catch (caught) {
        // A 401 is handled globally by the auth context; anything else is worth surfacing.
        if (!cancelled && caught instanceof ApiError && caught.status !== 401) {
          setError('Lost contact with the box office.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    setLoading(true);
    void tick(true);

    const onVisibilityChange = (): void => {
      if (!document.hidden) void tick(true);
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    const timer = setInterval(() => void tick(), POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [screeningId, refresh]);

  return { seatMap, reservations, loading, error, refresh };
}
