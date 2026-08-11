# Lumen Cinema — Seat Reservation System

A full-stack cinema booking application: sign in, view the seating map for a screening, hold
seats for 15 minutes, and complete the reservation. Two people can never end up with the same
seat, and the seat-selection rules are enforced on the server.

**Stack:** React 19 + Vite + TanStack Query · Node.js 24 + TypeScript + Express 5 ·
PostgreSQL 17 · Docker Compose

|                                          |                                                                              |
| ---------------------------------------- | ---------------------------------------------------------------------------- |
| Entity relationship diagram              | [`docs/ERD.md`](docs/ERD.md)                                                 |
| Architecture and design decisions        | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)                               |
| Schema (authoritative)                   | [`apps/api/db/migrations/001_init.sql`](apps/api/db/migrations/001_init.sql) |
| Seat rules (shared by client and server) | [`packages/shared/src/seatRules.ts`](packages/shared/src/seatRules.ts)       |

---

## Run it

### With Docker (nothing else required)

```bash
git clone <repository-url>
cd lumen-cinema
docker compose up --build
```

Then open **<http://localhost:8080>**.

The database schema is migrated and seeded automatically on first boot — no extra step. Four
showtimes are scheduled from the next full hour, and topped back up whenever the hall runs
out, so there is always something bookable however long the stack has been running. The API
is also published on <http://localhost:4000> if you want to poke at it directly.

```bash
docker compose down     # stop, keep the data
docker compose down -v  # stop and wipe the database
```

### Sign in

Three accounts are seeded. Open two browsers, sign in as different people, and race for the
same seat.

| Email               | Password       |
| ------------------- | -------------- |
| `alice@example.com` | `Password123!` |
| `bob@example.com`   | `Password123!` |
| `carol@example.com` | `Password123!` |

Or create your own account from the sign-in screen.

### Without Docker (for development)

Node.js 20+ and a Postgres you can reach.

```bash
cp .env.example .env       # defaults match the compose file
npm install
docker compose up -d db    # or point DATABASE_URL at your own Postgres
npm run dev                # API on :4000, web on :5173 with a proxy
```

Open <http://localhost:5173>.

---

## What it does

**Cinema layout** — 10 rows of 10 seats (A–J) plus 3 rows of 5 (K–M): 115 seats.

**Seat states** — `Available`, `Reserved` (someone holds it), `Booked` (paid for). Your own
holds are shown distinctly so you can tell your seats from other people's.

**Holds** — selecting seats creates a 15-minute hold. A live countdown shows the time left;
when it runs out the seats go back on sale automatically. You can confirm or release early.

**Rule 1 — seats must be consecutive.** Every seat in one reservation must be side by side in
the same row.

**Rule 2 — no isolated seat.** A selection may not leave a single empty seat trapped between
two occupied seats. A lone seat against the wall is fine.

```
Row A, seats 1–2 already booked

  1 2 3 4 5 6 7 8 9 10
  # # * * . . . . . .     valid    — nothing is stranded
  # # . * * . . . . .     rejected — seat 3 is trapped between 2 and 4
  . * * * * * * * * *     valid    — seat 1 is at the edge, not trapped
```

Both rules are validated **on the server**, inside the reservation transaction. The client
runs the same rule module on every click purely so the reason appears before you submit —
[one implementation, shared as a package](packages/shared/src/seatRules.ts).

---

## How double booking is prevented

Three layers, described in full in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md):

1. **A partial unique index** allows at most one active occupant per `(screening, seat)`.
   Concurrent inserts collide in the database; the loser gets `409`. This does not depend on
   application code being correct, single-process, or the only writer.
2. **A per-cinema-row advisory lock** taken for the duration of the transaction. Rule 2 is a
   statement about a whole row, so without it two users could each pass validation and
   _together_ strand a seat.
3. **Expired holds are reaped inside the same transaction**, so a seat freed a second ago is
   immediately reusable.

Expiry itself does not rely on a background job: the seat-map query ignores holds whose time
has passed, so a lapsed hold frees its seat the instant it lapses. The sweeper exists only to
clear dead rows out of the unique index.

Try it: `docker compose up`, sign in as Alice and Bob in two browsers, and click the same
seat at the same time. One of you gets it; the other is told, and the map refreshes.

---

## Quality gates

```bash
npm run verify   # lint + format check + typecheck + tests
```

Individually: `npm run lint`, `npm run format:check`, `npm run typecheck`, `npm test`.
All four run on every push and pull request via [GitHub Actions](.github/workflows/ci.yml),
along with a `docker compose build` that proves the documented setup path still works.

ESLint runs the React Compiler rules from `eslint-plugin-react-hooks`, which catch the
class of bug — `setState` inside effects, impure reads during render — that is invisible in
review and surfaces only as a wrong screen.

## Tests

```bash
npm test
```

- **24 unit tests** over the seat rules (`packages/shared`) — every worked example from the
  brief, both 10-seat and 5-seat rows, edges, and the pre-existing-gap case. No database.
- **17 integration tests** against a real Postgres (`apps/api`) — the rules over HTTP,
  ownership, the 15-minute lifecycle, expiry actually freeing a seat, and two genuine race
  tests: ten simultaneous requests for the same seats produce exactly one winner, and two
  users cannot jointly strand a seat.

The integration tests need a database: `npm run db:up` first (or run them while
`docker compose up` is running). They create their own screening, so they never disturb the
seeded data.

---

## API

All routes are under `/api`. Everything except `/auth/*`, `/health` and `/config` requires
`Authorization: Bearer <jwt>`.

| Method   | Path                           | Purpose                                                       |
| -------- | ------------------------------ | ------------------------------------------------------------- |
| `POST`   | `/auth/register`               | Create an account, returns a token                            |
| `POST`   | `/auth/login`                  | Sign in                                                       |
| `GET`    | `/auth/me`                     | Verify a stored token                                         |
| `GET`    | `/config`                      | Hold duration and seat cap, so the UI does not hard-code them |
| `GET`    | `/health`                      | Liveness plus database reachability                           |
| `GET`    | `/screenings`                  | Upcoming showtimes                                            |
| `GET`    | `/screenings/:id/seatmap`      | The seating map with every seat's status                      |
| `POST`   | `/screenings/:id/reservations` | Hold seats — `{ seatIds: number[] }`                          |
| `GET`    | `/screenings/:id/reservations` | Your reservations here; `?active=true` for live ones          |
| `POST`   | `/reservations/:id/confirm`    | Complete the reservation: held → booked                       |
| `DELETE` | `/reservations/:id`            | Release a hold early                                          |

Errors are always `{ error: { code, message, details? } }`. `409` means you lost a race and
should retry; `422` means the selection breaks a rule. Rule violations include a
`details.diagram` like `# # . * * . . . . .`.

---

## Configuration

Every value has a working default; `.env` is only needed outside Docker. See
[`.env.example`](.env.example).

| Variable                         | Default                  | Purpose                                    |
| -------------------------------- | ------------------------ | ------------------------------------------ |
| `DATABASE_URL`                   | —                        | Postgres connection string (required)      |
| `JWT_SECRET`                     | —                        | Token signing key, min 16 chars (required) |
| `HOLD_MINUTES`                   | `15`                     | How long a hold survives                   |
| `MAX_SEATS_PER_RESERVATION`      | `10`                     | Cap on one reservation                     |
| `EXPIRY_SWEEP_MS`                | `15000`                  | Sweeper cadence                            |
| `RUN_MIGRATIONS` / `RUN_SEED`    | `true`                   | Startup behaviour                          |
| `PORT` / `API_PORT` / `WEB_PORT` | `4000` / `4000` / `8080` | Ports                                      |

The server refuses to start on invalid configuration rather than booting half-configured.

Sign-in is rate limited to 20 **failed** attempts per IP per 15 minutes. Successful sign-ins
are not counted, so ordinary use is never throttled.

---

## Notes on AI usage

This solution was built with Claude (Claude Code). AI wrote the bulk of the code from a
specification I set out; the architecture decisions — deriving seat status instead of storing
it, using a partial unique index as the double-booking guard, choosing the cinema row as the
advisory-lock granularity, and the reading of Rule 2 that does not punish a user for a
pre-existing gap — were made deliberately and are documented in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Every claim in this README is backed by a
test that runs.
