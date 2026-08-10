import type { Reservation, ReservationSeatSummary, ReservationStatus } from '@lumen/shared';
import { validateSeatSelection } from '@lumen/shared';
import { config } from '../config.js';
import { pool, withTransaction, type Queryable } from '../db/pool.js';
import { AppError, PG_UNIQUE_VIOLATION, isPgError } from '../errors.js';
import { logger } from '../logger.js';
import { getScreeningOrThrow, loadSeatRows } from './screeningService.js';

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
 */
export async function releaseExpiredHolds(
  client: Queryable = pool,
  screeningId?: number,
): Promise<number> {
  const { rowCount } = await client.query(
    `UPDATE reservations
        SET status = 'expired', released_at = now()
      WHERE status = 'held'
        AND expires_at <= now()
        AND ($1::int IS NULL OR screening_id = $1)`,
    [screeningId ?? null],
  );
  return rowCount ?? 0;
}

export interface CreateHoldInput {
  userId: number;
  screeningId: number;
  seatIds: number[];
}

/**
 * Place a 15 minute hold on a set of seats.
 *
 * Concurrency strategy, in layers:
 *
 *  1. `pg_advisory_xact_lock(screening_id, row_index)` serialises everyone competing
 *     for the same cinema row. Rule 2 is a statement about the row as a whole, so two
 *     transactions reading the row simultaneously could each pass validation and
 *     together strand a seat. The lock removes that window, and because Rule 1 confines
 *     a selection to one row, it is the tightest granularity that is still correct.
 *     Different rows - and different screenings - never contend.
 *
 *  2. Expired holds for the row are reaped inside the same transaction, so a seat whose
 *     hold lapsed one second ago is immediately reusable.
 *
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

      // Resolve the requested seat ids to physical seats in this screening's hall.
      const { rows: requested } = await tx.query<{
        id: number;
        row_label: string;
        row_index: number;
        seat_number: number;
      }>(
        `SELECT id, row_label, row_index, seat_number
           FROM seats
          WHERE id = ANY($1::int[]) AND auditorium_id = $2`,
        [seatIds, screening.auditoriumId],
      );

      if (requested.length !== seatIds.length) {
        const found = new Set(requested.map((seat) => seat.id));
        throw AppError.unprocessable(
          'UNKNOWN_SEAT',
          'Some of those seats do not belong to this screening.',
          { seatIds: seatIds.filter((id) => !found.has(id)) },
        );
      }

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
      const rowIndex = first.row_index;

      // (1) Serialise on this screening's row.
      await tx.query('SELECT pg_advisory_xact_lock($1::int, $2::int)', [
        input.screeningId,
        rowIndex,
      ]);

      // (2) Reap anything that lapsed while we were waiting for the lock.
      await releaseExpiredHolds(tx, input.screeningId);

      // Read the row as it now stands, under the lock.
      const rowSeats = await loadSeatRows(input.screeningId, screening.auditoriumId, tx, rowLabel);

      const occupied = rowSeats
        .filter((seat) => seat.hold_status !== null)
        .map((seat) => seat.seat_number);
      const selected = requested.map((seat) => seat.seat_number).sort((a, b) => a - b);

      // Rule 1 (consecutive) and Rule 2 (no newly isolated seat).
      const verdict = validateSeatSelection({
        rowLength: rowSeats.length,
        occupied,
        selected,
        maxSeatsPerReservation: config.MAX_SEATS_PER_RESERVATION,
      });

      if (!verdict.ok) {
        const { code, message, seatNumbers, diagram } = verdict.violation;
        // A seat taken between the user's click and their submit is a race (409),
        // everything else is a rule they broke (422).
        const status = code === 'SEAT_UNAVAILABLE' ? 409 : 422;
        throw new AppError(status, code, message, {
          row: rowLabel,
          seatNumbers,
          diagram,
        });
      }

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
  if (current.status === 'held') {
    // Still 'held' but the UPDATE missed, so expiry is the only thing that blocked it.
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
