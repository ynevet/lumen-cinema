import { useCallback, useEffect, useMemo, useState } from 'react';
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
 */
export function useSeatSelection(
  seatMap: SeatMap | null,
  screeningId: number | null,
  maxSeats: number,
): SeatSelection {
  const [selected, setSelected] = useState<number[]>([]);

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

  // Seat ids are per-hall, not per-screening, so a stale selection would silently carry
  // across a showtime change. Start clean instead.
  useEffect(() => setSelected([]), [screeningId]);

  // Someone else may take a seat we have pencilled in. Drop it - and if losing it would
  // leave a gap in the middle of the run, drop the whole selection rather than leave the
  // user holding something the rules will reject.
  useEffect(() => {
    if (!seatMap) return;
    setSelected((current) => {
      if (current.length === 0) return current;
      const kept = current.filter((id) => seats.index.get(id)?.status === 'available');
      if (kept.length === current.length) return current;
      return isContiguous(seatNumbers(kept, seats.index)) ? kept : [];
    });
  }, [seatMap, seats]);

  const toggle = useCallback(
    (seat: SeatView) => {
      setSelected((current) => {
        const numbers = seatNumbers(current, seats.index);

        if (current.includes(seat.id)) {
          const isEndpoint =
            seat.seatNumber === numbers[0] || seat.seatNumber === numbers[numbers.length - 1];
          // Removing from the middle would split the run - restart from here instead.
          return isEndpoint ? current.filter((id) => id !== seat.id) : [seat.id];
        }

        if (current.length === 0) return [seat.id];
        if (current.length >= maxSeats) return [seat.id];
        if (seats.rows.get(current[0]!)?.label !== seat.rowLabel) return [seat.id];

        const extendsRun =
          seat.seatNumber === numbers[0]! - 1 ||
          seat.seatNumber === numbers[numbers.length - 1]! + 1;
        return extendsRun ? [...current, seat.id] : [seat.id];
      });
    },
    [seats, maxSeats],
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

  const clear = useCallback(() => setSelected([]), []);

  return { selected, labels, preflight, toggle, clear };
}
