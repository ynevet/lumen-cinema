# Lumen Cinema

Book cinema seats. Sign in, click a seat on the map, and it is reserved for you on the
spot and held for 15 minutes — then confirm it and it's booked.

Two people can never end up with the same seat, and the seat rules are enforced by the
server rather than the browser.

**Built with:** React 19 + Vite · Node.js + TypeScript + Express 5 · PostgreSQL 17 ·
Docker Compose

## Running it

You need Docker Desktop. Nothing else — no Node, no Postgres, no database setup.

```bash
git clone https://github.com/ynevet/lumen-cinema.git
cd lumen-cinema
docker compose up --build
```

The first build takes a couple of minutes. When the log says `"API listening"`, open
**<http://localhost:8080>**.

Sign in with any of the seeded accounts — they're printed on the sign-in screen too, so
there's nothing to remember:

| Email               | Password       |
| ------------------- | -------------- |
| `alice@example.com` | `Password123!` |
| `bob@example.com`   | `Password123!` |
| `carol@example.com` | `Password123!` |

Or make your own with **Create one**.

Showtimes are scheduled from the next full hour and topped back up when the hall runs out,
so there is always something bookable however long you leave it running.

To stop: `docker compose down`, or `docker compose down -v` to wipe the database as well.

## Using it

Pick a showtime from the cards at the top, then click a seat.

The seat is yours immediately — there's no "hold" button to press afterwards. Click the
seat next to it to add it, or click one of your own seats again to give it back. Seats are
outlined when free, amber when they're yours, grey when someone else is holding one, and
deep red when they're booked.

The 15-minute countdown starts with your **first** seat and covers the whole selection, so
adding a fourth seat doesn't buy you more time. When you're happy, **Confirm booking**
turns the whole selection into a booking. **Release** gives it back early, and if the clock
runs out the seats return to the map on their own.

A booking is one row at a time, so clicking into a different row asks whether you want to
give up the current one first.

## The two seat rules

**Seats must be consecutive.** Every seat in one booking sits side by side in the same row.

**No seat left stranded.** Your choice must not trap a single empty seat between two taken
ones. A lone seat against the wall is fine.

```
Row A, seats 1–2 already booked     (# taken · * your choice · . empty)

  1 2 3 4 5 6 7 8 9 10
  # # * * . . . . . .     fine     — nothing is stranded
  # # . * * . . . . .     refused  — seat 3 is trapped between 2 and 4
  . * * * * * * * * *     fine     — seat 1 is against the wall
```

If a click breaks a rule, the seat isn't reserved and you're told why, with a picture of
the row:

```
This selection would strand seat 5 alone between occupied seats.
# # # # . * * . . .
```

The rules apply when you give seats back as well as when you take them, so a seat can only
be released from either end of your run — never out of the middle.

One thing worth knowing: a row can already have a stranded seat before you touch anything,
because holds expire and bookings get cancelled. You're only stopped from creating a _new_
one. The reasoning is in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#interpreting-rule-2).

## Seeing that two people can't take the same seat

Open the app in two different browsers — or one normal and one private window, since two
tabs share a session. Sign in as alice in one and bob in the other, then click the same
seat in both at the same moment.

One of them gets it. The other is told someone was there first, and their map refreshes.
There is no moment where both succeed. It's proven by tests too, not just by hand.

## Tests

```bash
npm run db:up   # a database has to be running
npm test        # 24 unit + 33 integration tests
```

The unit tests cover the seat rules on their own and need no database. The integration
tests run against a real Postgres and cover the things only a database can settle — that
ten simultaneous requests for the same seats produce exactly one winner, that two people
can't jointly strand a seat, and that expiry really does put a seat back on sale. They
create their own screenings, so they never disturb the seeded data.

There are also two browser tests, which drive the real app end to end:

```bash
npx playwright install chromium   # first time only
docker compose stop api web       # they'd otherwise shadow the dev server on port 4000
npm run test:e2e
```

`npm run verify` runs everything CI runs: lint, formatting, types and tests.

## Working on it

Node.js 20 or newer, plus a reachable Postgres.

```bash
cp .env.example .env   # the defaults already match docker compose
npm install
npm run db:up          # just Postgres, in Docker
npm run dev            # API on :4000, web on :5173
```

Open <http://localhost:5173>. Both sides reload as you edit.

| Script                 | Does                                  |
| ---------------------- | ------------------------------------- |
| `npm run dev`          | API + web, watching for changes       |
| `npm test`             | Unit + integration tests              |
| `npm run test:e2e`     | The browser tests                     |
| `npm run verify`       | Lint, format, types and tests         |
| `npm run db:up`        | Start only the database               |
| `npm run docker:up`    | Build and start everything            |
| `npm run docker:reset` | Stop everything and wipe the database |

### Where things live

```
packages/shared/    types and the seat rules, used by both sides
apps/api/           Express + Postgres — routes, services, SQL migrations
apps/web/           React + Vite — hooks for the seat map and the live hold
e2e/                Playwright
docs/               how it works, and why
```

## When something goes wrong

**A port is already in use.** Pick different ones without editing anything:

```bash
WEB_PORT=9090 API_PORT=4100 POSTGRES_PORT=55432 docker compose up --build
```

**The page won't load.** Check the containers: `docker compose ps` should show all three
up, with the api and db healthy. `docker compose logs api` shows startup errors.

**Your changes don't show up in `npm run dev`.** The api container also uses port 4000 and
wins, so an old one left running serves the app instead of your code. `docker compose stop
api web` and leave the database up.

**The data looks wrong.** Start clean: `docker compose down -v && docker compose up --build`.

**Integration tests can't connect.** They need a database — `npm run db:up` first.

## Reading further

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — how it works and why, including how
  double booking is prevented and what each requirement maps to
- [`docs/API.md`](docs/API.md) — every endpoint, the error format, and configuration
- [`docs/ERD.md`](docs/ERD.md) — the data model
- [`apps/api/db/migrations/001_init.sql`](apps/api/db/migrations/001_init.sql) — the schema
  itself, which is the authoritative version
