import type { Screening, SeatMap, SeatMapRow, SeatStatus, SeatView } from '@lumen/shared';
import { pool, type Queryable } from '../db/pool.js';
import { AppError } from '../errors.js';

interface ScreeningRow {
  id: number;
  starts_at: Date;
  auditorium_id: number;
  auditorium_name: string;
  movie_id: number;
  movie_title: string;
  movie_duration_minutes: number;
}

const SCREENING_SELECT = `
  SELECT sc.id,
         sc.starts_at,
         sc.auditorium_id,
         a.name             AS auditorium_name,
         m.id               AS movie_id,
         m.title            AS movie_title,
         m.duration_minutes AS movie_duration_minutes
    FROM screenings  sc
    JOIN auditoriums a ON a.id = sc.auditorium_id
    JOIN movies      m ON m.id = sc.movie_id
`;

function toScreening(row: ScreeningRow): Screening {
  return {
    id: row.id,
    startsAt: row.starts_at.toISOString(),
    auditoriumId: row.auditorium_id,
    auditoriumName: row.auditorium_name,
    movieId: row.movie_id,
    movieTitle: row.movie_title,
    movieDurationMinutes: row.movie_duration_minutes,
  };
}

/**
 * Screenings you can still buy a ticket for. Past showings stay in the database - they
 * are the context for the reservations that point at them - but nobody should be offered
 * a seat at a film that already started.
 */
export async function listScreenings(): Promise<Screening[]> {
  const { rows } = await pool.query<ScreeningRow>(
    `${SCREENING_SELECT} WHERE sc.starts_at > now() ORDER BY sc.starts_at`,
  );
  return rows.map(toScreening);
}

export async function getScreeningOrThrow(
  screeningId: number,
  client: Queryable = pool,
): Promise<Screening> {
  const { rows } = await client.query<ScreeningRow>(`${SCREENING_SELECT} WHERE sc.id = $1`, [
    screeningId,
  ]);
  const row = rows[0];
  if (!row) {
    throw AppError.notFound('SCREENING_NOT_FOUND', 'That screening does not exist.');
  }
  return toScreening(row);
}

interface SeatRow {
  id: number;
  row_label: string;
  row_index: number;
  seat_number: number;
  hold_status: 'held' | 'booked' | null;
  held_by: number | null;
  expires_at: Date | null;
}

/**
 * Every seat in the auditorium with the reservation that currently occupies it.
 *
 * The LATERAL join is where "expired holds free the seat" happens: a hold whose
 * `expires_at` has passed simply stops matching, so the seat reads as available the
 * millisecond it expires - without waiting for the sweeper to run. The sweeper is a
 * tidy-up for the unique index, not the mechanism users depend on.
 */
export async function loadSeatRows(
  screeningId: number,
  auditoriumId: number,
  client: Queryable = pool,
  rowLabel?: string,
): Promise<SeatRow[]> {
  const { rows } = await client.query<SeatRow>(
    `SELECT s.id,
            s.row_label,
            s.row_index,
            s.seat_number,
            occ.status     AS hold_status,
            occ.user_id    AS held_by,
            occ.expires_at AS expires_at
       FROM seats s
       LEFT JOIN LATERAL (
            SELECT r.user_id, r.status, r.expires_at
              FROM reservation_seats rs
              JOIN reservations r ON r.id = rs.reservation_id
             WHERE rs.seat_id = s.id
               AND rs.screening_id = $1
               AND (r.status = 'booked' OR (r.status = 'held' AND r.expires_at > now()))
             LIMIT 1
       ) occ ON TRUE
      WHERE s.auditorium_id = $2
        AND ($3::text IS NULL OR s.row_label = $3)
      ORDER BY s.row_index, s.seat_number`,
    [screeningId, auditoriumId, rowLabel ?? null],
  );
  return rows;
}

function statusOf(row: SeatRow): SeatStatus {
  if (row.hold_status === 'booked') return 'booked';
  if (row.hold_status === 'held') return 'reserved';
  return 'available';
}

export async function getSeatMap(screeningId: number, viewerId: number): Promise<SeatMap> {
  const screening = await getScreeningOrThrow(screeningId);
  const seatRows = await loadSeatRows(screeningId, screening.auditoriumId);

  const rowsByLabel = new Map<string, SeatMapRow>();
  const totals = { available: 0, reserved: 0, booked: 0 };

  for (const row of seatRows) {
    const status = statusOf(row);
    totals[status] += 1;
    const mine = row.held_by === viewerId;

    const seat: SeatView = {
      id: row.id,
      rowLabel: row.row_label,
      rowIndex: row.row_index,
      seatNumber: row.seat_number,
      status,
      mine,
      // Only the owner learns when someone's hold runs out.
      holdExpiresAt: mine && row.expires_at ? row.expires_at.toISOString() : null,
    };

    let mapRow = rowsByLabel.get(row.row_label);
    if (!mapRow) {
      mapRow = { label: row.row_label, index: row.row_index, seatCount: 0, seats: [] };
      rowsByLabel.set(row.row_label, mapRow);
    }
    mapRow.seats.push(seat);
    mapRow.seatCount += 1;
  }

  return {
    screening,
    rows: [...rowsByLabel.values()].sort((a, b) => a.index - b.index),
    serverTime: new Date().toISOString(),
    totals,
  };
}
