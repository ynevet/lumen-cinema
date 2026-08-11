import bcrypt from 'bcryptjs';
import { DEFAULT_LAYOUT } from '@lumen/shared';
import { logger } from '../logger.js';
import { pool, withTransaction, type DbClient } from './pool.js';

/**
 * Idempotent seed. Safe to run on every boot: every statement either inserts
 * nothing new or is guarded by ON CONFLICT DO NOTHING.
 */

const AUDITORIUM_NAME = 'Hall 1';

const DEMO_USERS = [
  { email: 'alice@example.com', displayName: 'Alice Cohen', password: 'Password123!' },
  { email: 'bob@example.com', displayName: 'Bob Levi', password: 'Password123!' },
  { email: 'carol@example.com', displayName: 'Carol Ben-David', password: 'Password123!' },
];

const MOVIES = [
  {
    title: 'Dune: Part Two',
    durationMinutes: 166,
    synopsis: 'Paul Atreides unites with the Fremen to wage war against House Harkonnen.',
  },
  {
    title: 'The Grand Budapest Hotel',
    durationMinutes: 99,
    synopsis: 'A legendary concierge and his protege become entangled in a stolen painting.',
  },
  {
    title: 'Spirited Away',
    durationMinutes: 125,
    synopsis: 'A girl wanders into a world of spirits and must work to free her parents.',
  },
];

/**
 * Showtimes, as minutes from the top of the next hour. Relative rather than absolute so
 * a demo started at any time of day always has something upcoming to book.
 */
const SCREENING_SLOTS = [
  { movieIndex: 0, minutesFromNextHour: 0 },
  { movieIndex: 1, minutesFromNextHour: 90 },
  { movieIndex: 2, minutesFromNextHour: 210 },
  { movieIndex: 0, minutesFromNextHour: 330 },
];

async function seedAuditoriumAndSeats(tx: DbClient): Promise<number> {
  const { rows } = await tx.query<{ id: number }>(
    `INSERT INTO auditoriums (name) VALUES ($1)
     ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [AUDITORIUM_NAME],
  );
  const auditoriumId = rows[0]!.id;

  // Flatten the blueprint into three parallel arrays and let Postgres unnest them,
  // so the whole hall is one round trip instead of 115.
  const rowLabels: string[] = [];
  const rowIndexes: number[] = [];
  const seatNumbers: number[] = [];
  for (const row of DEFAULT_LAYOUT) {
    for (let seat = 1; seat <= row.seatCount; seat += 1) {
      rowLabels.push(row.label);
      rowIndexes.push(row.index);
      seatNumbers.push(seat);
    }
  }

  await tx.query(
    `INSERT INTO seats (auditorium_id, row_label, row_index, seat_number)
     SELECT $1, label, idx, num
       FROM unnest($2::text[], $3::int[], $4::int[]) AS t(label, idx, num)
     ON CONFLICT (auditorium_id, row_label, seat_number) DO NOTHING`,
    [auditoriumId, rowLabels, rowIndexes, seatNumbers],
  );

  return auditoriumId;
}

async function seedMovies(tx: DbClient): Promise<number[]> {
  const ids: number[] = [];
  for (const movie of MOVIES) {
    const { rows } = await tx.query<{ id: number }>(
      `INSERT INTO movies (title, duration_minutes, synopsis) VALUES ($1, $2, $3)
       ON CONFLICT (title) DO UPDATE
         SET duration_minutes = EXCLUDED.duration_minutes, synopsis = EXCLUDED.synopsis
       RETURNING id`,
      [movie.title, movie.durationMinutes, movie.synopsis],
    );
    ids.push(rows[0]!.id);
  }
  return ids;
}

/**
 * Schedules today's programme when the hall has nothing showing in the next 24 hours,
 * and does nothing otherwise. Returns how many screenings it added.
 *
 * This runs at startup *and* periodically from the maintenance job, because showtimes go
 * stale with the wall clock: seeding only at boot leaves a long-running container with an
 * empty programme once its last showing has started. A real cinema schedules its own
 * programme, so this is demo-data upkeep and is gated behind `RUN_SEED`.
 *
 * The window is deliberately 24 hours rather than "any future screening": the integration
 * tests create their own screening far in the future, and that must not suppress it.
 */
export async function ensureUpcomingScreenings(): Promise<number> {
  return withTransaction(async (tx) => {
    const { rows: halls } = await tx.query<{ id: number }>(
      `SELECT id FROM auditoriums WHERE name = $1`,
      [AUDITORIUM_NAME],
    );
    const auditoriumId = halls[0]?.id;
    if (auditoriumId === undefined) return 0;

    const { rows: counts } = await tx.query<{ upcoming: number }>(
      `SELECT count(*)::int AS upcoming
         FROM screenings
        WHERE auditorium_id = $1
          AND starts_at > now()
          AND starts_at < now() + interval '1 day'`,
      [auditoriumId],
    );
    if ((counts[0]?.upcoming ?? 0) > 0) return 0;

    const { rows: movies } = await tx.query<{ id: number }>(`SELECT id FROM movies ORDER BY id`);
    if (movies.length === 0) return 0;

    let scheduled = 0;
    for (const slot of SCREENING_SLOTS) {
      const movie = movies[slot.movieIndex % movies.length];
      if (!movie) continue;
      const { rowCount } = await tx.query(
        `INSERT INTO screenings (movie_id, auditorium_id, starts_at)
         VALUES ($1, $2, date_trunc('hour', now()) + interval '1 hour'
                          + make_interval(mins => $3::int))
         ON CONFLICT (auditorium_id, starts_at) DO NOTHING`,
        [movie.id, auditoriumId, slot.minutesFromNextHour],
      );
      scheduled += rowCount ?? 0;
    }
    return scheduled;
  });
}

async function seedUsers(tx: DbClient): Promise<void> {
  for (const user of DEMO_USERS) {
    const hash = await bcrypt.hash(user.password, 10);
    await tx.query(
      `INSERT INTO users (email, display_name, password_hash) VALUES ($1, $2, $3)
       ON CONFLICT (lower(email)) DO NOTHING`,
      [user.email, user.displayName, hash],
    );
  }
}

export async function runSeed(): Promise<void> {
  await withTransaction(async (tx) => {
    await seedAuditoriumAndSeats(tx);
    await seedMovies(tx);
    await seedUsers(tx);
  });

  // Needs the halls and films above to be committed first.
  await ensureUpcomingScreenings();

  const { rows } = await pool.query<{ seats: number; screenings: number; users: number }>(
    `SELECT (SELECT count(*) FROM seats)      AS seats,
            (SELECT count(*) FROM screenings) AS screenings,
            (SELECT count(*) FROM users)      AS users`,
  );

  logger.info(rows[0], 'Seed complete');
}
