import { useCallback, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Reservation, SeatView } from '@lumen/shared';
import { api } from '../api/client';
import { reservationsKey } from './useSeatMap';

export interface SeatSelection {
  /** Seat ids in the hold, for the seat map. */
  seatIds: ReadonlySet<number>;
  /** Human labels such as `A3`, in seat order. */
  labels: string[];
  /** The row the selection lives in, or `null` when nothing is selected. */
  rowLabel: string | null;
  /** A seat in another row, waiting for the user to agree to start again there. */
  pendingSwitch: SeatView | null;
  /** The seat whose click is still in flight, so the map can show it is working. */
  pendingSeatId: number | null;
  /** True while a click is in flight; further clicks are ignored until it lands. */
  busy: boolean;
  toggle: (seat: SeatView) => void;
  /** Release the current row and begin a new selection at `pendingSwitch`. */
  confirmSwitch: () => void;
  cancelSwitch: () => void;
}

interface Options {
  screeningId: number | null;
  /** The viewer's live holds and bookings for this screening. */
  reservations: Reservation[];
  refresh: () => Promise<void>;
  onError: (error: unknown) => void;
}

/**
 * Seats are reserved the instant they are clicked, so there is no such thing as a local,
 * unsubmitted selection any more: the selection *is* a hold on the server, and this hook
 * is the thing that edits it one seat at a time.
 *
 * Nothing about the selection is stored in React state - it is derived from the
 * reservations the server reports, so what is drawn is always what is actually held.
 * The rules are no longer mirrored here either: every click is a round trip that the API
 * validates under its row lock, and the error it returns is what the user is shown. A
 * second copy of the rules on the client could only ever disagree with it.
 *
 * The one piece of local state is `pendingSwitch`, which is a question being asked rather
 * than a fact about the world: a reservation lives in exactly one row, so clicking into a
 * different row means giving the current seats up, and that is the user's call to make.
 */
export function useSeatSelection({
  screeningId,
  reservations,
  refresh,
  onError,
}: Options): SeatSelection {
  const queryClient = useQueryClient();
  // Tagged with the screening it was asked about, so navigating away drops the question.
  const [asked, setAsked] = useState<{ screeningId: number; seat: SeatView } | null>(null);

  // The newest live hold is the selection in progress. Older ones are previous selections
  // the user chose to keep - they keep their own countdowns and their own Confirm button.
  const hold = useMemo(() => {
    const live = reservations.filter(
      (item) => item.status === 'held' && item.screeningId === screeningId,
    );
    return live.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
  }, [reservations, screeningId]);

  const seatIds = useMemo(() => new Set((hold?.seats ?? []).map((seat) => seat.seatId)), [hold]);

  const labels = useMemo(
    () => (hold?.seats ?? []).map((seat) => `${seat.rowLabel}${seat.seatNumber}`),
    [hold],
  );

  const rowLabel = hold?.seats[0]?.rowLabel ?? null;

  /**
   * Write the server's answer straight into the cache so the seat reacts to the click
   * without waiting for the poll, then re-read the map for everything else that moved.
   */
  const applyReservation = useCallback(
    async ({ reservation }: { reservation: Reservation }) => {
      queryClient.setQueryData<Reservation[]>(reservationsKey(screeningId), (previous = []) => {
        const others = previous.filter((item) => item.id !== reservation.id);
        const stillLive = reservation.status === 'held' || reservation.status === 'booked';
        return stillLive ? [reservation, ...others] : others;
      });
      await refresh();
    },
    [queryClient, refresh, screeningId],
  );

  const select = useMutation({
    mutationFn: (seatId: number) =>
      hold ? api.addSeat(hold.id, seatId) : api.hold(screeningId as number, [seatId]),
    onSuccess: applyReservation,
    onError,
  });

  const deselect = useMutation({
    mutationFn: ({ reservationId, seatId }: { reservationId: string; seatId: number }) =>
      api.removeSeat(reservationId, seatId),
    onSuccess: applyReservation,
    onError,
  });

  // Take the new row before giving up the old one. The other order reads more naturally
  // but fails badly: if somebody wins the race for the new seat in between, the user has
  // surrendered their row and gained nothing. This way the worst case is briefly holding
  // two rows, which is visible on screen and can be undone.
  const switchRow = useMutation({
    mutationFn: async ({ reservationId, seatId }: { reservationId: string; seatId: number }) => {
      const opened = await api.hold(screeningId as number, [seatId]);
      await api.release(reservationId);
      return opened;
    },
    onSuccess: applyReservation,
    onError,
    // Half of this can succeed, so re-read either way rather than only on the happy path.
    onSettled: async () => {
      setAsked(null);
      await refresh();
    },
  });

  const busy = select.isPending || deselect.isPending || switchRow.isPending;

  // Which seat the round trip is about. Taken from the mutation's own variables rather
  // than tracked separately, so it cannot survive the request it belongs to.
  let pendingSeatId: number | null = null;
  if (select.isPending) pendingSeatId = select.variables ?? null;
  else if (deselect.isPending) pendingSeatId = deselect.variables?.seatId ?? null;
  else if (switchRow.isPending) pendingSeatId = switchRow.variables?.seatId ?? null;

  // Only a live question deserves an answer: one asked about another screening, or about
  // a row the user has since given up anyway, quietly stops applying.
  const pendingSwitch =
    asked &&
    asked.screeningId === screeningId &&
    rowLabel !== null &&
    asked.seat.rowLabel !== rowLabel
      ? asked.seat
      : null;

  const toggle = useCallback(
    (seat: SeatView) => {
      if (busy || screeningId === null) return;
      setAsked(null);

      if (hold && seatIds.has(seat.id)) {
        deselect.mutate({ reservationId: hold.id, seatId: seat.id });
        return;
      }
      if (hold && rowLabel !== null && seat.rowLabel !== rowLabel) {
        setAsked({ screeningId, seat });
        return;
      }
      select.mutate(seat.id);
    },
    [busy, screeningId, seatIds, hold, rowLabel, select, deselect],
  );

  const confirmSwitch = useCallback(() => {
    if (!pendingSwitch || !hold) return;
    switchRow.mutate({ reservationId: hold.id, seatId: pendingSwitch.id });
  }, [pendingSwitch, hold, switchRow]);

  const cancelSwitch = useCallback(() => setAsked(null), []);

  return {
    seatIds,
    labels,
    rowLabel,
    pendingSwitch,
    pendingSeatId,
    busy,
    toggle,
    confirmSwitch,
    cancelSwitch,
  };
}
