import type {
  Reservation,
  ReservationSeatSummary,
  ReservationStatus,
  SelectionViolation,
} from '@lumen/shared';
import { validateSeatSelection } from '@lumen/shared';
import { config } from '../config.js';
import { pool, withTransaction, type Queryable } from '../db/pool.js';
import { AppError, PG_UNIQUE_VIOLATION, isPgError } from '../errors.js';
import { logger } from '../logger.js';
import { getScreeningOrThrow, loadSeatRows, type SeatRow } from './screeningService.js';

interface ReservationRow {
  id: string;
  screening_id: number;
  status: ReservationStatus;
  created_at: Date;
  expires_at: Date;
  confirmed_at: Date | null;
}

async function loadSeatSummaries(
  reservationIds: string[],
  client: Queryable = pool,
): Promise<Map<string, ReservationSeatSummary[]>> {
  const summaries = new Map<string, ReservationSeatSummary[]>();
  if (reservationIds.length === 0) return summaries;

  const { rows } = await client.query<{
    reservation_id: string;
    seat_id: number;
    row_label: string;
    seat_number: number;
  }>(
    `SELECT rs.reservation_id, rs.seat_id, s.row_label, s.seat_number
       FROM reservation_seats rs
       JOIN seats s ON s.id = rs.seat_id
      WHERE rs.reservation_id = ANY($1::uuid[])
      ORDER BY s.row_index, s.seat_number`,
    [reservationIds],
  );

  for (const row of rows) {
    const list = summaries.get(row.reservation_id) ?? [];
    list.push({ seatId: row.seat_id, rowLabel: row.row_label, seatNumber: row.seat_number });
    summaries.set(row.reservation_id, list);
  }
  return summaries;
}

function toReservation(row: ReservationRow, seats: ReservationSeatSummary[]): Reservation {
  return {
    id: row.id,
    screeningId: row.screening_id,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    confirmedAt: row.confirmed_at ? row.confirmed_at.toISOString() : null,
    seats,
  };
}

async function hydrate(rows: ReservationRow[]): Promise<Reservation[]> {
  const summaries = await loadSeatSummaries(rows.map((row) => row.id));
  return rows.map((row) => toReservation(row, summaries.get(row.id) ?? []));
}

async function hydrateOne(row: ReservationRow): Promise<Reservation> {
  const seats = await loadSeatSummaries([row.id]);
  return toReservation(row, seats.get(row.id) ?? []);
}

/**
 * Flip holds that have run out to `expired`. The trigger on `reservations` cascades the
 * status onto `reservation_seats`, which drops those rows out of the partial unique
 * index and makes the seats insertable again.
 *
 * Reads already ignore expired holds (see `loadSeatRows`), so this is not on the
 * critical path for correctness - it exists to stop dead rows from blocking the index.
 *
 * `SKIP LOCKED` is what keeps it off everybody else's critical path. Without it the reaper
 * can block on a hold another transaction has locked, and because it runs *inside* the
 * row lock it would then be holding one lock while waiting for another - a deadlock with
 * any transaction queueing for that row lock, resolved by Postgres shooting one of them.
 * A hold it skips is simply reaped on the next pass, which costs nothing: every read
 * already treats a lapsed hold as gone.
 */
export async function releaseExpiredHolds(
  client: Queryable = pool,
  screeningId?: number,
): Promise<number> {
  const { rowCount } = await client.query(
    `UPDATE reservations
        SET status = 'expired', released_at = now()
      WHERE id IN (
            SELECT id
              FROM reservations
             WHERE status = 'held'
               AND expires_at <= now()
               AND ($1::int IS NULL OR screening_id = $1)
               FOR UPDATE SKIP LOCKED
      )`,
    [screeningId ?? null],
  );
  return rowCount ?? 0;
}

interface SeatRecord {
  id: number;
  row_label: string;
  row_index: number;
  seat_number: number;
}

/**
 * You cannot buy a seat at a film that has already begun. `listScreenings` stops offering
 * it, but that is a read-path convenience - this is the enforcement. Compared against the
 * database clock, not the API server's, so the two can never disagree about whether a
 * showing has started.
 */
async function assertScreeningNotStarted(tx: Queryable, screeningId: number): Promise<void> {
  const { rows } = await tx.query<{ started: boolean }>(
    `SELECT starts_at <= now() AS started FROM screenings WHERE id = $1`,
    [screeningId],
  );
  if (rows[0]?.started) {
    throw AppError.conflict(
      'SCREENING_STARTED',
      'This screening has already started. Please choose a later showtime.',
    );
  }
}

/** Resolve seat ids to physical seats, insisting every one belongs to this screening's hall. */
async function resolveSeats(
  tx: Queryable,
  seatIds: number[],
  auditoriumId: number,
): Promise<SeatRecord[]> {
  const { rows } = await tx.query<SeatRecord>(
    `SELECT id, row_label, row_index, seat_number
       FROM seats
      WHERE id = ANY($1::int[]) AND auditorium_id = $2`,
    [seatIds, auditoriumId],
  );

  if (rows.length !== seatIds.length) {
    const found = new Set(rows.map((seat) => seat.id));
    throw AppError.unprocessable(
      'UNKNOWN_SEAT',
      'Some of those seats do not belong to this screening.',
      { seatIds: seatIds.filter((id) => !found.has(id)) },
    );
  }
  return rows;
}

/**
 * Serialise everyone competing for the same cinema row, then clear anything that lapsed
 * while we were waiting for the lock.
 *
 * Rule 2 is a statement about the row as a whole, so two transactions reading the row
 * simultaneously could each pass validation and together strand a seat. The lock removes
 * that window, and because Rule 1 confines a selection to one row, it is the tightest
 * granularity that is still correct. Different rows - and different screenings - never
 * contend. Reaping inside the same transaction means a seat whose hold lapsed one second
 * ago is immediately reusable.
 */
async function lockRow(tx: Queryable, screeningId: number, rowIndex: number): Promise<void> {
  await tx.query('SELECT pg_advisory_xact_lock($1::int, $2::int)', [screeningId, rowIndex]);
  await releaseExpiredHolds(tx, screeningId);
}

/** Seat numbers in this row occupied by somebody other than the reservation being edited. */
function occupiedByOthers(
  rowSeats: readonly SeatRow[],
  ownSeatIds: ReadonlySet<number> = new Set(),
): number[] {
  return rowSeats
    .filter((seat) => seat.hold_status !== null && !ownSeatIds.has(seat.id))
    .map((seat) => seat.seat_number);
}

function throwSelectionViolation(violation: SelectionViolation, rowLabel: string): never {
  const { code, message, seatNumbers, diagram } = violation;
  // A seat taken between the user's click and ours is a race (409), everything else is a
  // rule they broke (422).
  const status = code === 'SEAT_UNAVAILABLE' ? 409 : 422;
  throw new AppError(status, code, message, { row: rowLabel, seatNumbers, diagram });
}

export interface CreateHoldInput {
  userId: number;
  screeningId: number;
  seatIds: number[];
}

/**
 * Open a 15 minute hold on one or more seats.
 *
 * Concurrency strategy, in layers:
 *
 *  1. The per-row advisory lock taken by `lockRow` closes the read-then-write window.
 *  2. Expired holds for the screening are reaped under that lock.
 *  3. The partial unique index is the backstop. Even if the lock were bypassed (another
 *     service, a manual INSERT, a future code path that forgets), the database still
 *     refuses a second occupant and we translate 23505 into a 409.
 */
export async function createHold(input: CreateHoldInput): Promise<Reservation> {
  const seatIds = [...new Set(input.seatIds)];

  if (seatIds.length === 0) {
    throw AppError.unprocessable('EMPTY_SELECTION', 'Select at least one seat.');
  }
  if (seatIds.length > config.MAX_SEATS_PER_RESERVATION) {
    throw AppError.unprocessable(
      'TOO_MANY_SEATS',
      `You can reserve at most ${config.MAX_SEATS_PER_RESERVATION} seats in one go.`,
    );
  }

  try {
    return await withTransaction(async (tx) => {
      const screening = await getScreeningOrThrow(input.screeningId, tx);
      await assertScreeningNotStarted(tx, input.screeningId);

      const requested = await resolveSeats(tx, seatIds, screening.auditoriumId);

      // Rule 1, part one: a selection may not straddle rows.
      const distinctRows = new Set(requested.map((seat) => seat.row_label));
      if (distinctRows.size > 1) {
        throw AppError.unprocessable(
          'MULTIPLE_ROWS',
          'All seats in one reservation must be in the same row.',
          { rows: [...distinctRows].sort() },
        );
      }

      const first = requested[0]!;
      const rowLabel = first.row_label;

      await lockRow(tx, input.screeningId, first.row_index);

      // Read the row as it now stands, under the lock.
      const rowSeats = await loadSeatRows(input.screeningId, screening.auditoriumId, tx, rowLabel);

      // Rule 1 (consecutive) and Rule 2 (no newly isolated seat).
      const verdict = validateSeatSelection({
        rowLength: rowSeats.length,
        occupied: occupiedByOthers(rowSeats),
        selected: requested.map((seat) => seat.seat_number).sort((a, b) => a - b),
        maxSeatsPerReservation: config.MAX_SEATS_PER_RESERVATION,
      });
      if (!verdict.ok) throwSelectionViolation(verdict.violation, rowLabel);

      const { rows: created } = await tx.query<ReservationRow>(
        `INSERT INTO reservations (user_id, screening_id, status, expires_at)
         VALUES ($1, $2, 'held', now() + make_interval(mins => $3::int))
         RETURNING id, screening_id, status, created_at, expires_at, confirmed_at`,
        [input.userId, input.screeningId, config.HOLD_MINUTES],
      );
      const reservation = created[0]!;

      // (3) The unique index adjudicates any race that got past the lock.
      await tx.query(
        `INSERT INTO reservation_seats (reservation_id, seat_id, screening_id, auditorium_id, status)
         SELECT $1, seat_id, $2, $3, 'held' FROM unnest($4::int[]) AS t(seat_id)`,
        [reservation.id, input.screeningId, screening.auditoriumId, seatIds],
      );

      const seats = await loadSeatSummaries([reservation.id], tx);
      return toReservation(reservation, seats.get(reservation.id) ?? []);
    });
  } catch (error) {
    if (isPgError(error, PG_UNIQUE_VIOLATION)) {
      logger.info({ seatIds, screeningId: input.screeningId }, 'Lost a seat race');
      throw AppError.conflict(
        'SEAT_UNAVAILABLE',
        'Someone reserved one of those seats a moment before you. Please pick again.',
        { seatIds },
      );
    }
    throw error;
  }
}

interface LiveHold {
  row: ReservationRow;
  auditoriumId: number;
  /** The seats the hold currently occupies, in row order. */
  seats: SeatRecord[];
}

/**
 * Load a live hold belonging to this user, locking the reservation row for the rest of
 * the transaction. Seats are selected one click at a time, so two clicks can easily be
 * in flight together; the lock makes them queue instead of validating against the same
 * stale picture of the hold.
 *
 * The reservation row is always locked *before* the row-level advisory lock, in every path
 * that takes both. That ordering plus the reaper's `SKIP LOCKED` is what rules out a cycle:
 * nothing that already holds the advisory lock ever waits on a reservation row.
 */
async function loadLiveHold(
  tx: Queryable,
  reservationId: string,
  userId: number,
): Promise<LiveHold> {
  const { rows } = await tx.query<
    ReservationRow & { user_id: number; auditorium_id: number; lapsed: boolean }
  >(
    `SELECT r.id, r.user_id, r.screening_id, r.status, r.created_at, r.expires_at,
            r.confirmed_at, sc.auditorium_id, r.expires_at <= now() AS lapsed
       FROM reservations r
       JOIN screenings sc ON sc.id = r.screening_id
      WHERE r.id = $1
        FOR UPDATE OF r`,
    [reservationId],
  );

  const reservation = rows[0];
  // A reservation owned by somebody else is reported as absent rather than forbidden,
  // so ids cannot be probed for existence.
  if (!reservation || reservation.user_id !== userId) {
    throw AppError.notFound('RESERVATION_NOT_FOUND', 'That reservation does not exist.');
  }

  if (reservation.status === 'booked') {
    throw AppError.conflict(
      'ALREADY_BOOKED',
      'This reservation is already booked and its seats can no longer be changed.',
    );
  }
  if (reservation.status === 'cancelled') {
    throw AppError.conflict('RESERVATION_NOT_HELD', 'Those seats have already been released.');
  }
  // A lapsed hold reads as 'held' until the sweeper retires it, and 'expired' afterwards.
  // Both mean the same thing to the user, so both report the same code. `lapsed` is the
  // database's own verdict, so it cannot disagree with the reads that free the seat.
  if (reservation.status === 'expired' || reservation.lapsed) {
    throw AppError.conflict('HOLD_EXPIRED', 'Your hold expired and the seats were released.');
  }

  const { rows: seats } = await tx.query<SeatRecord>(
    `SELECT s.id, s.row_label, s.row_index, s.seat_number
       FROM reservation_seats rs
       JOIN seats s ON s.id = rs.seat_id
      WHERE rs.reservation_id = $1
      ORDER BY s.row_index, s.seat_number`,
    [reservationId],
  );

  return { row: reservation, auditoriumId: reservation.auditorium_id, seats };
}

export interface HoldSeatInput {
  reservationId: string;
  userId: number;
  seatId: number;
}

/**
 * Add one seat to a hold that is already running.
 *
 * `expires_at` is deliberately left alone: the countdown belongs to the selection as a
 * whole and starts with its first seat, so extending a selection must never buy the user
 * more time. The whole selection - not just the new seat - is revalidated, because both
 * rules are statements about the finished run rather than about individual clicks.
 */
export async function addSeatToHold(input: HoldSeatInput): Promise<Reservation> {
  try {
    return await withTransaction(async (tx) => {
      const hold = await loadLiveHold(tx, input.reservationId, input.userId);
      await assertScreeningNotStarted(tx, hold.row.screening_id);

      const seat = (await resolveSeats(tx, [input.seatId], hold.auditoriumId))[0]!;

      // Clicking a seat we already hold is a no-op, not an error - a click that crossed
      // with a retry should not punish the user.
      if (hold.seats.some((held) => held.id === seat.id)) {
        const current = await loadSeatSummaries([hold.row.id], tx);
        return toReservation(hold.row, current.get(hold.row.id) ?? []);
      }

      const anchor = hold.seats[0];
      if (anchor && anchor.row_label !== seat.row_label) {
        throw AppError.unprocessable(
          'MULTIPLE_ROWS',
          'All seats in one reservation must be in the same row.',
          { rows: [anchor.row_label, seat.row_label] },
        );
      }

      await lockRow(tx, hold.row.screening_id, seat.row_index);

      const rowSeats = await loadSeatRows(
        hold.row.screening_id,
        hold.auditoriumId,
        tx,
        seat.row_label,
      );

      const verdict = validateSeatSelection({
        rowLength: rowSeats.length,
        occupied: occupiedByOthers(rowSeats, new Set(hold.seats.map((held) => held.id))),
        selected: [...hold.seats.map((held) => held.seat_number), seat.seat_number].sort(
          (a, b) => a - b,
        ),
        maxSeatsPerReservation: config.MAX_SEATS_PER_RESERVATION,
      });
      if (!verdict.ok) throwSelectionViolation(verdict.violation, seat.row_label);

      await tx.query(
        `INSERT INTO reservation_seats (reservation_id, seat_id, screening_id, auditorium_id, status)
         VALUES ($1, $2, $3, $4, 'held')`,
        [hold.row.id, seat.id, hold.row.screening_id, hold.auditoriumId],
      );

      const seats = await loadSeatSummaries([hold.row.id], tx);
      return toReservation(hold.row, seats.get(hold.row.id) ?? []);
    });
  } catch (error) {
    if (isPgError(error, PG_UNIQUE_VIOLATION)) {
      logger.info({ seatId: input.seatId, reservationId: input.reservationId }, 'Lost a seat race');
      throw AppError.conflict(
        'SEAT_UNAVAILABLE',
        'Someone reserved that seat a moment before you. Please pick another.',
        { seatIds: [input.seatId] },
      );
    }
    throw error;
  }
}

/**
 * Rejections that only make sense when *removing* a seat. The validator speaks in terms
 * of a selection being made, so a bare "seats must be next to each other" would leave the
 * user guessing which of their clicks was the problem.
 */
function throwReleaseViolation(violation: SelectionViolation, seat: SeatRecord): never {
  const label = `${seat.row_label}${seat.seat_number}`;

  if (violation.code === 'NOT_CONSECUTIVE') {
    throw AppError.unprocessable(
      'SEAT_NOT_AT_EDGE',
      `Releasing ${label} would split your selection in two. Seats can only be given back from either end.`,
      { seatNumbers: violation.seatNumbers, diagram: violation.diagram },
    );
  }
  if (violation.code === 'ISOLATED_SEAT') {
    const stranded = violation.seatNumbers ?? [];
    throw AppError.unprocessable(
      'ISOLATED_SEAT',
      `Releasing ${label} would strand seat ${stranded.join(', ')} alone between occupied seats. Release the whole selection instead.`,
      { seatNumbers: stranded, diagram: violation.diagram },
    );
  }
  throwSelectionViolation(violation, seat.row_label);
}

/**
 * Give one seat back while keeping the rest of the hold - and its original countdown -
 * intact. Releasing the last seat is the same thing as releasing the reservation.
 *
 * What is left behind has to satisfy the rules just as much as what was taken: dropping a
 * seat out of the middle of a run would break Rule 1, and dropping one off the end can
 * strand a neighbour under Rule 2. Both are refused rather than silently repaired.
 */
export async function removeSeatFromHold(input: HoldSeatInput): Promise<Reservation> {
  return withTransaction(async (tx) => {
    const hold = await loadLiveHold(tx, input.reservationId, input.userId);

    // Already gone, so there is nothing to do and nothing to complain about. A response
    // that never arrived and a click that was sent twice both land here, and every other
    // write on a reservation is a no-op on repeat for the same reason.
    const target = hold.seats.find((seat) => seat.id === input.seatId);
    if (!target) {
      const current = await loadSeatSummaries([hold.row.id], tx);
      return toReservation(hold.row, current.get(hold.row.id) ?? []);
    }

    const remaining = hold.seats.filter((seat) => seat.id !== target.id);

    if (remaining.length === 0) {
      await tx.query(`DELETE FROM reservation_seats WHERE reservation_id = $1`, [hold.row.id]);
      const { rows } = await tx.query<ReservationRow>(
        `UPDATE reservations
            SET status = 'cancelled', released_at = now()
          WHERE id = $1
          RETURNING id, screening_id, status, created_at, expires_at, confirmed_at`,
        [hold.row.id],
      );
      return toReservation(rows[0]!, []);
    }

    await lockRow(tx, hold.row.screening_id, target.row_index);

    const rowSeats = await loadSeatRows(
      hold.row.screening_id,
      hold.auditoriumId,
      tx,
      target.row_label,
    );

    const verdict = validateSeatSelection({
      rowLength: rowSeats.length,
      occupied: occupiedByOthers(rowSeats, new Set(hold.seats.map((seat) => seat.id))),
      selected: remaining.map((seat) => seat.seat_number).sort((a, b) => a - b),
      maxSeatsPerReservation: config.MAX_SEATS_PER_RESERVATION,
    });
    if (!verdict.ok) throwReleaseViolation(verdict.violation, target);

    await tx.query(`DELETE FROM reservation_seats WHERE reservation_id = $1 AND seat_id = $2`, [
      hold.row.id,
      target.id,
    ]);

    const seats = await loadSeatSummaries([hold.row.id], tx);
    return toReservation(hold.row, seats.get(hold.row.id) ?? []);
  });
}

/**
 * Turn a live hold into a booking.
 *
 * The UPDATE carries every precondition in its WHERE clause, so it is atomic on its own -
 * no transaction and no SELECT ... FOR UPDATE needed. If it matches nothing we read the row
 * once, purely to tell the user *why*. Confirming twice is a no-op rather than an error.
 */
export async function confirmHold(reservationId: string, userId: number): Promise<Reservation> {
  const { rows } = await pool.query<ReservationRow>(
    `UPDATE reservations
        SET status = 'booked', confirmed_at = now()
      WHERE id = $1 AND user_id = $2 AND status = 'held' AND expires_at > now()
      RETURNING id, screening_id, status, created_at, expires_at, confirmed_at`,
    [reservationId, userId],
  );

  const confirmed = rows[0];
  if (confirmed) return hydrateOne(confirmed);

  const current = await loadOwnReservation(reservationId, userId);
  if (current.status === 'booked') return hydrateOne(current);
  // A lapsed hold reads as 'held' until the maintenance job retires it, and 'expired'
  // afterwards. Both mean the same thing to the user, so both report the same code -
  // otherwise the error would depend on whether the sweeper had happened to run yet.
  if (current.status === 'held' || current.status === 'expired') {
    throw AppError.conflict('HOLD_EXPIRED', 'Your hold expired and the seats were released.');
  }
  throw AppError.conflict(
    'RESERVATION_NOT_HELD',
    `This reservation was ${current.status} and can no longer be confirmed.`,
  );
}

/** Give the seats back before the hold runs out. Releasing twice is a no-op. */
export async function cancelHold(reservationId: string, userId: number): Promise<Reservation> {
  const { rows } = await pool.query<ReservationRow>(
    `UPDATE reservations
        SET status = 'cancelled', released_at = now()
      WHERE id = $1 AND user_id = $2 AND status = 'held'
      RETURNING id, screening_id, status, created_at, expires_at, confirmed_at`,
    [reservationId, userId],
  );

  const cancelled = rows[0];
  if (cancelled) return hydrateOne(cancelled);

  const current = await loadOwnReservation(reservationId, userId);
  if (current.status === 'booked') {
    throw AppError.conflict(
      'ALREADY_BOOKED',
      'This reservation is already booked and cannot be released here.',
    );
  }
  // Already expired or cancelled - the seats are free either way.
  return hydrateOne(current);
}

/**
 * Load a reservation that belongs to this user. A reservation owned by somebody else is
 * reported as absent rather than forbidden, so ids cannot be probed for existence.
 */
async function loadOwnReservation(reservationId: string, userId: number): Promise<ReservationRow> {
  const { rows } = await pool.query<ReservationRow & { user_id: number }>(
    `SELECT id, user_id, screening_id, status, created_at, expires_at, confirmed_at
       FROM reservations WHERE id = $1`,
    [reservationId],
  );
  const reservation = rows[0];
  if (!reservation || reservation.user_id !== userId) {
    throw AppError.notFound('RESERVATION_NOT_FOUND', 'That reservation does not exist.');
  }
  return reservation;
}

export async function listMyReservations(
  userId: number,
  options: { screeningId?: number; activeOnly?: boolean } = {},
): Promise<Reservation[]> {
  const { rows } = await pool.query<ReservationRow>(
    `SELECT id, screening_id, status, created_at, expires_at, confirmed_at
       FROM reservations
      WHERE user_id = $1
        AND ($2::int IS NULL OR screening_id = $2)
        AND ($3::bool IS NOT TRUE
             OR status = 'booked'
             OR (status = 'held' AND expires_at > now()))
      ORDER BY created_at DESC`,
    [userId, options.screeningId ?? null, options.activeOnly ?? false],
  );
  return hydrate(rows);
}

export async function getMyReservation(
  reservationId: string,
  userId: number,
): Promise<Reservation> {
  return hydrateOne(await loadOwnReservation(reservationId, userId));
}
