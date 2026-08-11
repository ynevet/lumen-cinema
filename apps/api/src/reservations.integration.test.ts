/**
 * Integration tests against a real Postgres.
 *
 * The unit tests in @lumen/shared prove the rules in isolation; these prove the
 * things only a database can prove: that concurrent requests cannot both win, that
 * expiry actually frees a seat, and that the rules survive the round trip.
 *
 * Requires a database - `npm run db:up` starts one. Each run creates its own
 * screening, so tests never collide with the seed data or with each other.
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import type { SeatMap } from '@lumen/shared';
import { createApp } from './app.js';
import { closePool, pool } from './db/pool.js';
import { runMigrations } from './db/migrate.js';
import { ensureUpcomingScreenings, runSeed } from './db/seed.js';
import { listScreenings } from './services/screeningService.js';
import { releaseExpiredHolds } from './services/reservationService.js';

let app: Express;
let screeningId: number;
let alice: string;
let bob: string;

const PASSWORD = 'Password123!';

async function signUp(app: Express, label: string): Promise<string> {
  const email = `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`;
  const response = await request(app)
    .post('/api/auth/register')
    .send({ email, displayName: `Test ${label}`, password: PASSWORD })
    .expect(201);
  return response.body.token as string;
}

async function seatMap(token: string): Promise<SeatMap> {
  const response = await request(app)
    .get(`/api/screenings/${screeningId}/seatmap`)
    .set('authorization', `Bearer ${token}`)
    .expect(200);
  return response.body as SeatMap;
}

function seatIds(map: SeatMap, rowLabel: string, numbers: number[]): number[] {
  const row = map.rows.find((item) => item.label === rowLabel);
  if (!row) throw new Error(`Row ${rowLabel} not found`);
  return numbers.map((number) => {
    const seat = row.seats.find((item) => item.seatNumber === number);
    if (!seat) throw new Error(`Seat ${rowLabel}${number} not found`);
    return seat.id;
  });
}

function hold(token: string, ids: number[]) {
  return request(app)
    .post(`/api/screenings/${screeningId}/reservations`)
    .set('authorization', `Bearer ${token}`)
    .send({ seatIds: ids });
}

beforeAll(async () => {
  // Both are idempotent, so the suite is self-sufficient: it works against a database the
  // API has never booted against, which is what CI gives us.
  await runMigrations();
  await runSeed();
  app = createApp();

  // A private screening in the seeded hall keeps this run isolated from every other.
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO screenings (movie_id, auditorium_id, starts_at)
     SELECT m.id, a.id, now() + interval '400 days' + (random() * interval '300 days')
       FROM movies m CROSS JOIN auditoriums a
      ORDER BY m.id, a.id
      LIMIT 1
     RETURNING id`,
  );
  const created = rows[0];
  if (!created)
    throw new Error('Seed data missing - start the API once to seed, or run RUN_SEED=true.');
  screeningId = created.id;

  alice = await signUp(app, 'alice');
  bob = await signUp(app, 'bob');
});

afterAll(async () => {
  await pool.query('DELETE FROM reservations WHERE screening_id = $1', [screeningId]);
  await pool.query('DELETE FROM screenings WHERE id = $1', [screeningId]);
  await closePool();
});

describe('authentication', () => {
  it('refuses the seat map without a token', async () => {
    await request(app).get(`/api/screenings/${screeningId}/seatmap`).expect(401);
  });

  it('refuses a forged token', async () => {
    await request(app)
      .get(`/api/screenings/${screeningId}/seatmap`)
      .set('authorization', 'Bearer not.a.jwt')
      .expect(401);
  });
});

describe('screening programme', () => {
  it('offers only screenings that have not started', async () => {
    const now = Date.now();
    const offered = await listScreenings();
    expect(offered.every((item) => new Date(item.startsAt).getTime() > now)).toBe(true);
  });

  it('tops the programme back up once every showing has started', async () => {
    // Exactly what happens to a container left running past its last screening: age the
    // whole programme into the past. Shifting keeps the times distinct, so the
    // (auditorium, starts_at) uniqueness constraint still holds.
    // Map each row to a distinct slot in the distant past, keyed by its id. That is
    // collision-proof against the (auditorium, starts_at) constraint and idempotent, so
    // re-running the suite against the same database behaves identically.
    await pool.query(
      `UPDATE screenings
          SET starts_at = timestamptz '2000-01-01 00:00:00+00' + make_interval(mins => id)
        WHERE starts_at > now() AND starts_at < now() + interval '1 day'`,
    );

    // This suite's own screening sits 400+ days out, so look only at the near programme.
    const soon = async () => {
      const horizon = Date.now() + 24 * 60 * 60 * 1000;
      const offered = await listScreenings();
      return offered.filter((item) => new Date(item.startsAt).getTime() < horizon);
    };

    expect(await soon()).toHaveLength(0);

    const scheduled = await ensureUpcomingScreenings();
    expect(scheduled).toBeGreaterThan(0);

    const offered = await soon();
    expect(offered.length).toBeGreaterThan(0);
    expect(offered.every((item) => new Date(item.startsAt).getTime() > Date.now())).toBe(true);

    // And it does not keep adding to an already-stocked programme.
    expect(await ensureUpcomingScreenings()).toBe(0);
  });
});

describe('seat map', () => {
  it('matches the specified layout', async () => {
    const map = await seatMap(alice);
    expect(map.rows).toHaveLength(13);
    expect(map.rows.slice(0, 10).every((row) => row.seatCount === 10)).toBe(true);
    expect(map.rows.slice(10).every((row) => row.seatCount === 5)).toBe(true);
    expect(map.totals.available).toBe(115);
  });
});

describe('selection rules over HTTP', () => {
  it('rejects a non-consecutive selection', async () => {
    const map = await seatMap(alice);
    const response = await hold(alice, seatIds(map, 'C', [2, 4])).expect(422);
    expect(response.body.error.code).toBe('NOT_CONSECUTIVE');
  });

  it('rejects seats spread across two rows', async () => {
    const map = await seatMap(alice);
    const response = await hold(alice, [
      ...seatIds(map, 'C', [1]),
      ...seatIds(map, 'D', [1]),
    ]).expect(422);
    expect(response.body.error.code).toBe('MULTIPLE_ROWS');
  });

  it('rejects a selection that would strand a single seat', async () => {
    await hold(bob, seatIds(await seatMap(bob), 'E', [1, 2])).expect(201);

    const response = await hold(alice, seatIds(await seatMap(alice), 'E', [4, 5])).expect(422);
    expect(response.body.error.code).toBe('ISOLATED_SEAT');
    expect(response.body.error.details.seatNumbers).toEqual([3]);
    expect(response.body.error.details.diagram).toBe('# # . * * . . . . .');
  });

  it('accepts the selection that closes the gap instead', async () => {
    await hold(alice, seatIds(await seatMap(alice), 'E', [3, 4])).expect(201);
  });

  it('allows a lone seat left against the wall', async () => {
    const map = await seatMap(alice);
    await hold(alice, seatIds(map, 'G', [2, 3, 4, 5, 6, 7, 8, 9, 10])).expect(201);
  });

  it('rejects seats that are already taken', async () => {
    const response = await hold(bob, seatIds(await seatMap(bob), 'E', [1, 2])).expect(409);
    expect(response.body.error.code).toBe('SEAT_UNAVAILABLE');
  });

  it('refuses to sell seats for a screening that has already started', async () => {
    // Hiding a started screening from the list is a convenience; the write path has to
    // enforce it, or the rule only exists for clients that bother to look.
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO screenings (movie_id, auditorium_id, starts_at)
       SELECT m.id, a.id, now() - interval '3 hours' - make_interval(secs => $1::int)
         FROM movies m CROSS JOIN auditoriums a
        ORDER BY m.id, a.id
        LIMIT 1
       RETURNING id`,
      [Math.floor(Math.random() * 100_000)],
    );
    const startedId = rows[0]!.id;

    try {
      const map = await request(app)
        .get(`/api/screenings/${startedId}/seatmap`)
        .set('authorization', `Bearer ${alice}`)
        .expect(200);

      const seat = (map.body as SeatMap).rows[0]!.seats[0]!.id;
      const response = await request(app)
        .post(`/api/screenings/${startedId}/reservations`)
        .set('authorization', `Bearer ${alice}`)
        .send({ seatIds: [seat] })
        .expect(409);
      expect(response.body.error.code).toBe('SCREENING_STARTED');
    } finally {
      await pool.query('DELETE FROM screenings WHERE id = $1', [startedId]);
    }
  });
});

describe('concurrency', () => {
  it('lets exactly one of ten simultaneous requests win the same seats', async () => {
    const map = await seatMap(alice);
    const contested = seatIds(map, 'H', [4, 5]);

    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, index) => hold(index % 2 === 0 ? alice : bob, contested)),
    );

    const created = responses.filter((response) => response.status === 201);
    const conflicts = responses.filter((response) => response.status === 409);

    expect(created).toHaveLength(1);
    expect(conflicts).toHaveLength(9);

    // And the database agrees: one active occupant per seat, no more.
    const { rows } = await pool.query<{ seat_id: number; occupants: number }>(
      `SELECT seat_id, count(*)::int AS occupants
         FROM reservation_seats
        WHERE screening_id = $1 AND seat_id = ANY($2::int[]) AND status IN ('held', 'booked')
        GROUP BY seat_id`,
      [screeningId, contested],
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.occupants === 1)).toBe(true);
  });

  it('does not let two users jointly strand a seat in the same row', async () => {
    // Alice wants I1-I2 and Bob wants I4-I5. Each is fine on its own, but together
    // they would leave I3 marooned. The per-row lock forces one to lose.
    const map = await seatMap(alice);
    const [left, right] = await Promise.all([
      hold(alice, seatIds(map, 'I', [1, 2])),
      hold(bob, seatIds(map, 'I', [4, 5])),
    ]);

    const statuses = [left.status, right.status].sort();
    expect(statuses).toEqual([201, 422]);
  });
});

describe('hold lifecycle', () => {
  it('holds for exactly 15 minutes', async () => {
    const map = await seatMap(alice);
    const response = await hold(alice, seatIds(map, 'J', [1, 2])).expect(201);
    const { createdAt, expiresAt } = response.body.reservation;
    const minutes = (new Date(expiresAt).getTime() - new Date(createdAt).getTime()) / 60_000;
    expect(Math.round(minutes)).toBe(15);
  });

  it('releases the seats when the hold expires', async () => {
    const map = await seatMap(alice);
    const ids = seatIds(map, 'K', [1, 2]);
    const created = await hold(alice, ids).expect(201);

    const before = await seatMap(bob);
    expect(before.rows.find((row) => row.label === 'K')!.seats[0]!.status).toBe('reserved');

    // Age the whole reservation by 16 minutes rather than waiting for real time.
    // Both timestamps move, so the `expires_at > created_at` check still holds -
    // this is exactly the state the row would reach on its own.
    await pool.query(
      `UPDATE reservations
          SET created_at = now() - interval '16 minutes',
              expires_at = now() - interval '1 minute'
        WHERE id = $1`,
      [created.body.reservation.id],
    );

    // Reads treat a lapsed hold as gone immediately, without waiting for the sweeper.
    const after = await seatMap(bob);
    expect(after.rows.find((row) => row.label === 'K')!.seats[0]!.status).toBe('available');

    // And the seats are genuinely re-sellable.
    await hold(bob, ids).expect(201);

    // The owner can no longer turn the lapsed hold into a booking.
    const beforeSweep = await request(app)
      .post(`/api/reservations/${created.body.reservation.id}/confirm`)
      .set('authorization', `Bearer ${alice}`)
      .expect(409);
    expect(beforeSweep.body.error.code).toBe('HOLD_EXPIRED');

    // Same answer once the maintenance job has retired the row: the error a user sees
    // must not depend on whether the sweeper happened to run first.
    await releaseExpiredHolds();
    const afterSweep = await request(app)
      .post(`/api/reservations/${created.body.reservation.id}/confirm`)
      .set('authorization', `Bearer ${alice}`)
      .expect(409);
    expect(afterSweep.body.error.code).toBe('HOLD_EXPIRED');
  });

  it('confirms a hold into a booking', async () => {
    const map = await seatMap(alice);
    const created = await hold(alice, seatIds(map, 'L', [1, 2])).expect(201);

    const confirmed = await request(app)
      .post(`/api/reservations/${created.body.reservation.id}/confirm`)
      .set('authorization', `Bearer ${alice}`)
      .expect(200);
    expect(confirmed.body.reservation.status).toBe('booked');

    const after = await seatMap(bob);
    expect(after.rows.find((row) => row.label === 'L')!.seats[0]!.status).toBe('booked');

    // Confirming twice is a no-op rather than an error.
    await request(app)
      .post(`/api/reservations/${created.body.reservation.id}/confirm`)
      .set('authorization', `Bearer ${alice}`)
      .expect(200);
  });

  it('frees the seats when a hold is released early', async () => {
    const map = await seatMap(alice);
    const ids = seatIds(map, 'M', [1, 2]);
    const created = await hold(alice, ids).expect(201);

    await request(app)
      .delete(`/api/reservations/${created.body.reservation.id}`)
      .set('authorization', `Bearer ${alice}`)
      .expect(200);

    const after = await seatMap(bob);
    expect(after.rows.find((row) => row.label === 'M')!.seats[0]!.status).toBe('available');
    await hold(bob, ids).expect(201);
  });

  it("hides other people's reservations behind a 404", async () => {
    const map = await seatMap(alice);
    const created = await hold(alice, seatIds(map, 'B', [1, 2])).expect(201);

    await request(app)
      .post(`/api/reservations/${created.body.reservation.id}/confirm`)
      .set('authorization', `Bearer ${bob}`)
      .expect(404);

    await request(app)
      .delete(`/api/reservations/${created.body.reservation.id}`)
      .set('authorization', `Bearer ${bob}`)
      .expect(404);
  });

  it('only reveals hold expiry to the owner', async () => {
    const map = await seatMap(alice);
    await hold(alice, seatIds(map, 'F', [1, 2])).expect(201);

    const own = await seatMap(alice);
    const ownSeat = own.rows.find((row) => row.label === 'F')!.seats[0]!;
    expect(ownSeat.mine).toBe(true);
    expect(ownSeat.holdExpiresAt).not.toBeNull();

    const other = await seatMap(bob);
    const otherSeat = other.rows.find((row) => row.label === 'F')!.seats[0]!;
    expect(otherSeat.status).toBe('reserved');
    expect(otherSeat.mine).toBe(false);
    expect(otherSeat.holdExpiresAt).toBeNull();
  });
});
