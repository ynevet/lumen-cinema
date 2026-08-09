/**
 * Seat selection rules.
 *
 * These are pure functions over a single cinema row. They are the single source of
 * truth for both sides of the wire: the API runs them inside the reservation
 * transaction (authoritative), and the web client runs them on every click so the
 * user gets instant feedback instead of a round-trip rejection.
 *
 * Rule 1 - all selected seats are consecutive and inside one row.
 * Rule 2 - the selection must not create a single empty seat trapped between two
 *          occupied seats. Gaps at the edge of a row are always allowed.
 */

export type SelectionErrorCode =
  | 'EMPTY_SELECTION'
  | 'TOO_MANY_SEATS'
  | 'DUPLICATE_SEATS'
  | 'SEAT_OUT_OF_RANGE'
  | 'MULTIPLE_ROWS'
  | 'NOT_CONSECUTIVE'
  | 'SEAT_UNAVAILABLE'
  | 'ISOLATED_SEAT';

export interface SelectionInput {
  /** Number of seats in the row, 1-based seat numbers run 1..rowLength. */
  rowLength: number;
  /** Seat numbers already taken by someone else (status Reserved or Booked). */
  occupied: readonly number[];
  /** Seat numbers the user wants to hold. */
  selected: readonly number[];
  /** Upper bound on a single reservation. */
  maxSeatsPerReservation?: number;
}

export interface SelectionViolation {
  code: SelectionErrorCode;
  message: string;
  /** Seat numbers that caused the rejection, when applicable. */
  seatNumbers?: number[];
  /** ASCII picture of the row after applying the selection - handy in errors and tests. */
  diagram?: string;
}

export type SelectionResult = { ok: true } | { ok: false; violation: SelectionViolation };

/**
 * A reservation may not be wider than the widest row. The brief's own "valid" example
 * takes 9 of 10 seats in one go, so anything lower would contradict the spec; the cap
 * exists only to stop absurd payloads, not to be a business rule of its own.
 */
export const DEFAULT_MAX_SEATS_PER_RESERVATION = 10;

/**
 * Seat numbers that sit alone in a gap of exactly one, with an occupied seat on
 * both sides. Seats 1 and `rowLength` can never qualify: they have a wall on one
 * side, which the specification explicitly allows.
 */
export function findTrappedSingles(occupied: ReadonlySet<number>, rowLength: number): number[] {
  const trapped: number[] = [];
  for (let seat = 2; seat <= rowLength - 1; seat += 1) {
    if (!occupied.has(seat) && occupied.has(seat - 1) && occupied.has(seat + 1)) {
      trapped.push(seat);
    }
  }
  return trapped;
}

/**
 * ASCII rendering of a row: `#` occupied, `*` selected, `.` empty.
 * Mirrors the notation used in the specification.
 */
export function renderRowDiagram(
  rowLength: number,
  occupied: readonly number[],
  selected: readonly number[],
): string {
  const occupiedSet = new Set(occupied);
  const selectedSet = new Set(selected);
  const cells: string[] = [];
  for (let seat = 1; seat <= rowLength; seat += 1) {
    if (selectedSet.has(seat)) cells.push('*');
    else if (occupiedSet.has(seat)) cells.push('#');
    else cells.push('.');
  }
  return cells.join(' ');
}

function fail(violation: SelectionViolation): SelectionResult {
  return { ok: false, violation };
}

/**
 * Validate a selection inside one row.
 *
 * Note on Rule 2: we reject only traps the selection is *responsible for*. A row can
 * already contain a trapped single seat before the user touches anything (holds expire
 * independently, bookings get cancelled), and punishing the next user for a gap they
 * did not create would make those seats permanently unsellable. So we compare the row
 * before and after: a trap that already existed and is untouched by this selection does
 * not block it, while any newly created trap does.
 */
export function validateSeatSelection(input: SelectionInput): SelectionResult {
  const {
    rowLength,
    occupied,
    selected,
    maxSeatsPerReservation = DEFAULT_MAX_SEATS_PER_RESERVATION,
  } = input;

  if (selected.length === 0) {
    return fail({ code: 'EMPTY_SELECTION', message: 'Select at least one seat.' });
  }

  if (selected.length > maxSeatsPerReservation) {
    return fail({
      code: 'TOO_MANY_SEATS',
      message: `You can reserve at most ${maxSeatsPerReservation} seats in one go.`,
    });
  }

  const uniqueSelected = [...new Set(selected)].sort((a, b) => a - b);
  if (uniqueSelected.length !== selected.length) {
    return fail({ code: 'DUPLICATE_SEATS', message: 'The same seat was selected twice.' });
  }

  const outOfRange = uniqueSelected.filter(
    (seat) => !Number.isInteger(seat) || seat < 1 || seat > rowLength,
  );
  if (outOfRange.length > 0) {
    return fail({
      code: 'SEAT_OUT_OF_RANGE',
      message: `This row only has seats 1-${rowLength}.`,
      seatNumbers: outOfRange,
    });
  }

  // Rule 1 - consecutive. (Single-row-ness is enforced by the caller, which resolves
  // seat ids to rows; here the input is already scoped to one row.)
  const first = uniqueSelected[0]!;
  const last = uniqueSelected[uniqueSelected.length - 1]!;
  if (last - first + 1 !== uniqueSelected.length) {
    return fail({
      code: 'NOT_CONSECUTIVE',
      message: 'Selected seats must be next to each other, with no gaps.',
      seatNumbers: uniqueSelected,
      diagram: renderRowDiagram(rowLength, occupied, uniqueSelected),
    });
  }

  const occupiedBefore = new Set(occupied);
  const clash = uniqueSelected.filter((seat) => occupiedBefore.has(seat));
  if (clash.length > 0) {
    return fail({
      code: 'SEAT_UNAVAILABLE',
      message: 'One or more of those seats have just been taken.',
      seatNumbers: clash,
      diagram: renderRowDiagram(rowLength, occupied, uniqueSelected),
    });
  }

  // Rule 2 - no newly isolated seat.
  const occupiedAfter = new Set(occupiedBefore);
  for (const seat of uniqueSelected) occupiedAfter.add(seat);

  const trappedBefore = new Set(findTrappedSingles(occupiedBefore, rowLength));
  const newlyTrapped = findTrappedSingles(occupiedAfter, rowLength).filter(
    (seat) => !trappedBefore.has(seat),
  );

  if (newlyTrapped.length > 0) {
    const plural = newlyTrapped.length > 1;
    return fail({
      code: 'ISOLATED_SEAT',
      message: `This selection would strand ${plural ? 'seats' : 'seat'} ${newlyTrapped.join(
        ', ',
      )} alone between occupied seats. Shift your selection by one, or take ${
        plural ? 'those seats' : 'that seat'
      } too.`,
      seatNumbers: newlyTrapped,
      diagram: renderRowDiagram(rowLength, occupied, uniqueSelected),
    });
  }

  return { ok: true };
}
