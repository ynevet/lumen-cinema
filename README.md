# Lumen Cinema — Seat Reservation System

Book cinema seats: sign in, pick seats on the seating map, hold them for 15 minutes, and
complete the reservation. Two people can never end up with the same seat, and the
seat-selection rules are enforced on the server.

**Stack:** React 19 + Vite + TanStack Query · Node.js + TypeScript + Express 5 ·
PostgreSQL 17 · Docker Compose

<sub>

[Quick start](#quick-start) · [Using the app](#using-the-app) ·
[See the concurrency guarantee](#see-the-concurrency-guarantee-for-yourself) ·
[What’s implemented](#whats-implemented) · [Project layout](#project-layout) ·
[Local development](#local-development-without-docker) · [Tests](#tests) · [API](#api) ·
[Configuration](#configuration) · [Troubleshooting](#troubleshooting)

</sub>

---

## Quick start

**You need:** Docker Desktop (or Docker Engine + Compose v2). Nothing else — no Node, no
Postgres, no manual database setup.

```bash
git clone https://github.com/ynevet/lumen-cinema.git
cd lumen-cinema
docker compose up --build
```

First run takes a couple of minutes to build the images. When you see
`cinema-api | ... "API listening"`, open:

> ### 👉 **<http://localhost:8080>**

Sign in with any of the seeded accounts:

| Email               | Password       |
| ------------------- | -------------- |
| `alice@example.com` | `Password123!` |
| `bob@example.com`   | `Password123!` |
| `carol@example.com` | `Password123!` |

They are shown on the sign-in screen too, so nothing needs to be memorised. You can also
create your own account with **Create one**.

The schema is migrated and the data seeded automatically on first boot. Four showtimes are
scheduled starting from the next full hour, and topped back up whenever the hall runs out —
so there is always something bookable no matter when or how long you run it.

**Stopping:**

```bash
docker compose down      # stop, keep the database
docker compose down -v   # stop and wipe the database (fresh start next time)
```

The API is also published on <http://localhost:4000> if you want to call it directly.

---

## Using the app

Once signed in you are on the booking screen.

**1. Pick a showtime.** The row of cards at the top lists upcoming screenings. The selected
one is highlighted; clicking another swaps the seat map.

**2. Pick your seats.** Click any available seat, then click the seat next to it to extend
your selection. Seats are colour-coded:

|                       | Meaning                                   |
| --------------------- | ----------------------------------------- |
| Outlined              | **Available** — click to select           |
| Amber, filled         | **Your selection** — not reserved yet     |
| Amber, dashed outline | **Held by you** — a live 15-minute hold   |
| Grey                  | **Reserved** — someone else is holding it |
| Deep red              | **Booked** — paid for                     |

A legend and a running count of available / reserved / booked sit under the map.

> **Selection tips.** A booking must be **consecutive seats in one row**, so clicking a seat
> that cannot extend your current run simply starts a new selection there — you can't get
> stuck. Hover a seat to see its number.

**3. Hold the seats.** Your selection appears on the ticket stub on the right. Click
**Hold for 15 min**. Those seats immediately become unavailable to everyone else.

If the selection breaks a rule, the button is disabled and the stub explains why, with a
diagram of the row — for example:

```
This selection would strand seat 5 alone between occupied seats.
# # # # . * * . . .
```

**4. Complete the reservation.** The hold appears below the ticket with a live countdown.
Click **Confirm booking** to turn it into a booking, or **Release** to give the seats back
early. If the countdown reaches `00:00`, the hold expires on its own and the seats go back on
sale automatically.

### The two seat-selection rules

**Rule 1 — seats must be consecutive.** Every seat in one reservation must sit side by side
in the same row.

**Rule 2 — no isolated seat.** A selection may not leave a single empty seat trapped between
two occupied seats. A lone seat against the wall or aisle is fine.

```
Row A, seats 1–2 already booked        (# occupied · * your selection · . empty)

  1 2 3 4 5 6 7 8 9 10
  # # * * . . . . . .     valid    — nothing is stranded
  # # . * * . . . . .     rejected — seat 3 is trapped between 2 and 4
  . * * * * * * * * *     valid    — seat 1 is at the edge, not trapped
```

Both rules are validated **on the server**, inside the reservation transaction. The client
runs the very same rule module on every click so the reason appears before you submit —
[one implementation, shared as a package](packages/shared/src/seatRules.ts).

> **Note on Rule 2.** A row can already contain a trapped seat before you touch anything —
> holds expire and bookings get cancelled independently. Rejecting every later selection in
> that row would make those seats permanently unsellable, so we reject only a trap your
> selection **creates**. All three worked examples above behave exactly as written. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#interpreting-rule-2).

---

## See the concurrency guarantee for yourself

Two seats can never be sold twice. To watch it happen:

1. Open <http://localhost:8080> in two different browsers (or one normal window and one
   private window — they need separate sessions).
2. Sign in as `alice@example.com` in one and `bob@example.com` in the other.
3. Pick the **same seats** in both, then click **Hold for 15 min** in both as close to
   simultaneously as you can.

One of you gets the seats. The other is told _"Someone reserved one of those seats a moment
before you"_, and their map refreshes to show the seats as reserved. There is no window in
which both succeed.

You can also watch a hold expire: hold some seats, then leave the tab open. The countdown
runs down, and when it hits zero the seats return to the map as available.

This is proven by tests as well as by hand — see [Tests](#tests).

---

## What’s implemented

What the application does, and where each part lives:

| Capability                                                            | Where                                                                                    |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Email + password sign-in, JWT sessions                                | [`authService.ts`](apps/api/src/services/authService.ts)                                 |
| Seating map with a live status for every seat                         | [`screeningService.ts`](apps/api/src/services/screeningService.ts)                       |
| 115 seats — 10 rows of 10, 3 rows of 5                                | [`layout.ts`](packages/shared/src/layout.ts)                                             |
| Seat status Available / Reserved / Booked, derived rather than stored | [`docs/ERD.md`](docs/ERD.md)                                                             |
| Select consecutive seats, kept legal as you click                     | [`useSeatSelection.ts`](apps/web/src/hooks/useSeatSelection.ts)                          |
| Rule 1 — consecutive seats in one row, enforced server-side           | [`seatRules.ts`](packages/shared/src/seatRules.ts)                                       |
| Rule 2 — no isolated empty seat, enforced server-side                 | Same module, inside the reservation transaction                                          |
| 15-minute hold, released automatically when it lapses                 | `HOLD_MINUTES`; expiry is a property of every read                                       |
| Complete the reservation, or release the seats early                  | `POST /reservations/:id/confirm`, `DELETE /reservations/:id`                             |
| Two users can never take the same seat                                | Partial unique index + per-row advisory lock — [below](#how-double-booking-is-prevented) |
| Seat map stays current without a refresh                              | [`useSeatMap.ts`](apps/web/src/hooks/useSeatMap.ts) — TanStack Query polling             |
| Sign-in rate limiting                                                 | [`rateLimit.ts`](apps/api/src/middleware/rateLimit.ts)                                   |

### How double booking is prevented

Three layers, described in full in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md):

1. **A partial unique index** allows at most one active occupant per `(screening, seat)`.
   Concurrent inserts collide in the database; the loser gets `409`. This does not depend on
   application code being correct, single-process, or the only writer.
2. **A per-cinema-row advisory lock** held for the transaction. Rule 2 is a statement about a
   whole row, so without it two users could each pass validation and _together_ strand a
   seat.
3. **Expired holds are reaped inside the same transaction**, so a seat freed a second ago is
   immediately reusable.

Expiry does not depend on a background job being healthy: the seat-map query ignores holds
whose time has passed, so a lapsed hold frees its seat the instant it lapses.

---

## Project layout

```
lumen-cinema/          npm workspaces, one lockfile
├── packages/shared/                @lumen/shared — types + seat rules, used by BOTH sides
├── apps/api/                       @lumen/api    — Express 5 + TypeScript + node-postgres
│   ├── src/routes/                 HTTP: parse, authorise, delegate
│   ├── src/services/               the domain work
│   ├── src/jobs/                   expiry sweep + programme upkeep
│   └── db/migrations/              plain .sql, applied at startup
├── apps/web/                       @lumen/web    — React 19 + Vite
│   ├── src/hooks/                  useSeatMap (polling), useSeatSelection (rules)
│   └── src/components/             rendering
├── docs/                           ERD + architecture notes
└── docker-compose.yml              db + api + web
```

---

## Local development (without Docker)

Node.js 20+ (CI runs 24) and a reachable Postgres.

```bash
cp .env.example .env       # defaults already match the compose file
npm install
npm run db:up              # starts just Postgres in Docker
npm run dev                # API on :4000, web on :5173 (proxied, so no CORS)
```

Open <http://localhost:5173>. Both sides hot-reload.

If you have your own Postgres, skip `npm run db:up` and point `DATABASE_URL` at it instead.

### npm scripts

| Script                            | Does                                             |
| --------------------------------- | ------------------------------------------------ |
| `npm run dev`                     | API + web in watch mode                          |
| `npm run build`                   | Build all three workspaces                       |
| `npm test`                        | Unit + integration tests                         |
| `npm run lint` / `lint:fix`       | ESLint                                           |
| `npm run format` / `format:check` | Prettier                                         |
| `npm run typecheck`               | `tsc` across the workspaces                      |
| `npm run verify`                  | lint + format + typecheck + tests (what CI runs) |
| `npm run db:up`                   | Start only the database container                |
| `npm run docker:up`               | Build and start the whole stack                  |
| `npm run docker:reset`            | Stop everything and wipe the database            |

---

## Tests

```bash
npm test
```

- **24 unit tests** over the seat rules (`packages/shared`) — every worked example from the
  specification, both 10-seat and 5-seat rows, edge seats, and the pre-existing-gap case. No
  database needed.
- **19 integration tests** against a real Postgres (`apps/api`) — the rules over HTTP,
  ownership, the 15-minute lifecycle, expiry actually freeing a seat, programme upkeep, and
  two genuine race tests: **ten simultaneous requests for the same seats produce exactly one
  winner**, and two users cannot jointly strand a seat.

The integration tests need a database — run `npm run db:up` first, or run them while
`docker compose up` is going. They create their own screening, so they never disturb the
seeded data.

### Quality gates

```bash
npm run verify   # lint + format check + typecheck + tests
```

All of it runs on every push and pull request via
[GitHub Actions](.github/workflows/ci.yml), alongside a `docker compose build` and health
check that proves the setup path in this README still works.

---

## API

All routes are under `/api`. Everything except `/auth/*`, `/health` and `/config` requires
an `Authorization: Bearer <jwt>` header.

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

Try it from the command line:

```bash
TOKEN=$(curl -s localhost:4000/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"alice@example.com","password":"Password123!"}' | jq -r .token)

curl -s localhost:4000/api/screenings -H "authorization: Bearer $TOKEN" | jq
```

Errors are always `{ error: { code, message, details? } }`. **`409`** means the state of the
world changed under you — refresh and try again; **`422`** means the selection breaks a rule. Rule violations include a
`details.diagram` such as `# # . * * . . . . .`.

---

## Configuration

Every value has a working default, and `docker compose` supplies its own — `.env` is only
needed when running outside Docker. See [`.env.example`](.env.example).

| Variable                         | Default                  | Purpose                                        |
| -------------------------------- | ------------------------ | ---------------------------------------------- |
| `DATABASE_URL`                   | —                        | Postgres connection string (required)          |
| `JWT_SECRET`                     | —                        | Token signing key, min 16 chars (required)     |
| `HOLD_MINUTES`                   | `15`                     | How long a hold survives                       |
| `MAX_SEATS_PER_RESERVATION`      | `10`                     | Cap on one reservation                         |
| `EXPIRY_SWEEP_MS`                | `15000`                  | Maintenance cadence: expiry + programme upkeep |
| `RUN_MIGRATIONS` / `RUN_SEED`    | `true`                   | Startup behaviour                              |
| `PORT` / `API_PORT` / `WEB_PORT` | `4000` / `4000` / `8080` | Ports                                          |

The server refuses to start on invalid configuration rather than booting half-configured.

Sign-in is rate limited to 20 **failed** attempts per IP per 15 minutes. Successful sign-ins
are not counted, so ordinary use is never throttled.

---

## Troubleshooting

**"Port is already allocated" / the ports are in use.** Change them without editing any
committed file:

```bash
WEB_PORT=9090 API_PORT=4100 POSTGRES_PORT=55432 docker compose up --build
```

**The page doesn't load, or the API returns 502.** Check everything is healthy:

```bash
docker compose ps                 # all three should be Up, api and db "(healthy)"
docker compose logs api           # startup errors show here
curl localhost:8080/api/health    # expects {"status":"ok","database":"up",...}
```

**"Cannot reach the box office."** The API or database is not up yet. `docker compose up`
waits for the database and the API health check before starting the web container, so give
the first build a minute, then re-check with the commands above.

**"Too many failed sign-in attempts."** You hit the rate limit — 20 failed attempts per IP
per 15 minutes. Wait it out, or `docker compose restart api` to reset the counter.

**Something looks wrong with the data.** Start completely fresh:

```bash
docker compose down -v && docker compose up --build
```

**Integration tests fail with a connection error.** They need a database:
`npm run db:up` first.

---

## Documentation

|                                          |                                                                              |
| ---------------------------------------- | ---------------------------------------------------------------------------- |
| Entity relationship diagram              | [`docs/ERD.md`](docs/ERD.md)                                                 |
| Architecture and design decisions        | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)                               |
| Schema (authoritative)                   | [`apps/api/db/migrations/001_init.sql`](apps/api/db/migrations/001_init.sql) |
| Seat rules (shared by client and server) | [`packages/shared/src/seatRules.ts`](packages/shared/src/seatRules.ts)       |
