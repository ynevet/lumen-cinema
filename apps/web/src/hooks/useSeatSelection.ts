import { useCallback, useMemo, useState } from 'react';
import type { SeatMap, SeatMapRow, SeatView } from '@lumen/shared';
import { validateSeatSelection, type SelectionResult } from '@lumen/shared';

export interface SeatSelection {
  /** Seat ids the user has picked but not yet submitted. */
  selected: number[];
  /** Human labels such as `A3`, in seat order. */
  labels: string[];
  /**
   * The same rules the API enforces, run against the pending selection. `null` when
   * nothing is selected. The server still has the final word - this only saves the
   * user a rejected round-trip.
   */
  preflight: SelectionResult | null;
  toggle: (seat: SeatView) => void;
  clear: () => void;
}

interface SelectionState {
  /** The screening the ids belong to. Seat ids are per-hall, so this must be checked. */
  screeningId: number | null;
  seatIds: number[];
}

function seatNumbers(ids: readonly number[], index: Map<number, SeatView>): number[] {
  return ids
    .map((id) => index.get(id)?.seatNumber)
    .filter((number): number is number => number !== undefined)
    .sort((a, b) => a - b);
}

function isContiguous(numbers: readonly number[]): boolean {
  if (numbers.length === 0) return true;
  return numbers[numbers.length - 1]! - numbers[0]! + 1 === numbers.length;
}

/**
 * Owns the pending seat selection and keeps it legal by construction: one row, always
 * contiguous. Clicking somewhere that cannot extend the current run starts a new one,
 * which is less irritating than an error message for something we can simply fix.
 *
 * Both ways a selection can go stale - switching screening, and somebody else taking a
 * seat we had pencilled in - are resolved by *deriving* the effective selection during
 * render rather than by effects that write state. No extra render pass, and no window in
 * which the rest of the UI can observe a selection that is no longer valid.
 */
export function useSeatSelection(
  seatMap: SeatMap | null,
  screeningId: number | null,
  maxSeats: number,
): SeatSelection {
  const [state, setState] = useState<SelectionState>({ screeningId, seatIds: [] });

  const seats = useMemo(() => {
    const index = new Map<number, SeatView>();
    const rows = new Map<number, SeatMapRow>();
    for (const row of seatMap?.rows ?? []) {
      for (const seat of row.seats) {
        index.set(seat.id, seat);
        rows.set(seat.id, row);
      }
    }
    return { index, rows };
  }, [seatMap]);

  const selected = useMemo(() => {
    // A selection made for another showtime does not carry over.
    if (state.screeningId !== screeningId) return [];
    // Drop seats somebody else has taken since. If losing one would split the run, drop
    // the lot rather than leave the user holding something the rules will reject.
    const kept = state.seatIds.filter((id) => seats.index.get(id)?.status === 'available');
    if (kept.length === state.seatIds.length) return state.seatIds;
    return isContiguous(seatNumbers(kept, seats.index)) ? kept : [];
  }, [state, screeningId, seats]);

  const toggle = useCallback(
    (seat: SeatView) => {
      const numbers = seatNumbers(selected, seats.index);
      const only = (id: number): SelectionState => ({ screeningId, seatIds: [id] });

      if (selected.includes(seat.id)) {
        const isEndpoint =
          seat.seatNumber === numbers[0] || seat.seatNumber === numbers[numbers.length - 1];
        // Removing from the middle would split the run - restart from here instead.
        setState(
          isEndpoint
            ? { screeningId, seatIds: selected.filter((id) => id !== seat.id) }
            : only(seat.id),
        );
        return;
      }

      if (selected.length === 0 || selected.length >= maxSeats) {
        setState(only(seat.id));
        return;
      }
      if (seats.rows.get(selected[0]!)?.label !== seat.rowLabel) {
        setState(only(seat.id));
        return;
      }

      const extendsRun =
        seat.seatNumber === numbers[0]! - 1 || seat.seatNumber === numbers[numbers.length - 1]! + 1;
      setState(extendsRun ? { screeningId, seatIds: [...selected, seat.id] } : only(seat.id));
    },
    [selected, seats, screeningId, maxSeats],
  );

  const row = selected[0] === undefined ? null : (seats.rows.get(selected[0]) ?? null);

  const preflight = useMemo(() => {
    if (selected.length === 0 || !row) return null;
    return validateSeatSelection({
      rowLength: row.seatCount,
      occupied: row.seats.filter((s) => s.status !== 'available').map((s) => s.seatNumber),
      selected: seatNumbers(selected, seats.index),
      maxSeatsPerReservation: maxSeats,
    });
  }, [selected, row, seats, maxSeats]);

  const labels = useMemo(
    () => (row ? seatNumbers(selected, seats.index).map((n) => `${row.label}${n}`) : []),
    [selected, row, seats],
  );

  const clear = useCallback(() => setState({ screeningId, seatIds: [] }), [screeningId]);

  return { selected, labels, preflight, toggle, clear };
}
