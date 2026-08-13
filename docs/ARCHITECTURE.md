# Architecture

## Shape of the repository

```
lumen-cinema/
├── packages/shared/        @lumen/shared - types + seat-selection rules
├── apps/api/               @lumen/api    - Express 5 + TypeScript + node-postgres
│   ├── src/routes/         HTTP shape: parse, authorise, delegate
│   ├── src/services/       the domain work
│   └── db/migrations/      versioned SQL, applied at startup
├── apps/web/               @lumen/web    - React 19 + Vite
│   ├── src/hooks/          useSeatMap (polling), useSeatSelection (editing the live hold)
│   └── src/components/     rendering
├── e2e/                    Playwright, driving the browser against the real stack
├── docs/                   ERD, API reference, this document
└── docker-compose.yml      db + api + web
```

Three layers on the server (route → service → SQL) and no more. There is no repository or
DAO layer: it would only forward calls, and the queries here are the interesting part of the
design rather than an implementation detail worth hiding.

On the client, the two mechanisms that carry state — polling the seat map, and editing the
live hold — live in hooks so each is small enough to reason about, leaving the component to
render. Neither keeps a private copy of the selection: it is derived from the reservations
the server reports, so what is drawn is always what is actually held.

npm workspaces, one lockfile, one TypeScript project graph. `@lumen/shared` is a real
package rather than a folder of copied files, which is what allows the seat rules to be
literally the same code on both sides of the wire.

## Where each requirement lives

| Requirement                                                   | Where                                                                 |
| ------------------------------------------------------------- | --------------------------------------------------------------------- |
| Email + password sign-in, JWT sessions                        | [`authService.ts`](../apps/api/src/services/authService.ts)           |
| Seating map with a live status for every seat                 | [`screeningService.ts`](../apps/api/src/services/screeningService.ts) |
| 115 seats — 10 rows of 10, 3 rows of 5                        | [`layout.ts`](../packages/shared/src/layout.ts)                       |
| Seat status Available / Reserved / Booked, derived not stored | [`ERD.md`](ERD.md)                                                    |
| A seat is Reserved on the click that selects it               | [`useSeatSelection.ts`](../apps/web/src/hooks/useSeatSelection.ts)    |
| One 15-minute clock per selection, started by its first seat  | `addSeatToHold` never touches `expires_at`                            |
| Deselecting a seat frees it immediately                       | `DELETE /reservations/:id/seats/:seatId`                              |
| Rule 1 — consecutive seats in one row, enforced server-side   | [`seatRules.ts`](../packages/shared/src/seatRules.ts)                 |
| Rule 2 — no isolated empty seat, enforced server-side         | Same module, inside the reservation transaction                       |
| Completing a reservation is held → booked, nothing else       | `confirmHold`                                                         |
| A hold released automatically when it lapses                  | `HOLD_MINUTES`; expiry is a property of every read                    |
| Two users can never take the same seat                        | Partial unique index + per-row advisory lock, below                   |
| An error when somebody else already took the seat             | `409 SEAT_UNAVAILABLE`, surfaced as a toast                           |
| Sign-in rate limiting                                         | [`rateLimit.ts`](../apps/api/src/middleware/rateLimit.ts)             |

## The three problems worth solving

Everything else here is ordinary CRUD. These three are not.

### 1. Two users must never get the same seat

Three layers, from strongest to weakest:

**A partial unique index.** `reservation_seats` may hold at most one row per
`(screening_id, seat_id)` whose status is `held` or `booked`. Concurrent inserts collide in
the index; one commits, the other gets SQLSTATE `23505` and becomes a `409`. This holds
regardless of how many API processes run, and regardless of whether anyone remembered to
take a lock.

**A per-row advisory lock**, `pg_advisory_xact_lock(screening_id, row_index)`. Rule 2 is a
statement about a whole cinema row, so two transactions that read the row at the same moment
could each pass validation and _together_ strand a seat — a race the unique index cannot see,
because they are inserting different seats. The lock serialises everyone competing for the
same row. Since Rule 1 confines a selection to a single row, the row is the tightest
granularity that is still correct: different rows and different screenings never contend.

**Expired-hold reaping inside the same transaction**, so a seat whose hold lapsed a second
ago is immediately reusable rather than waiting for the sweeper.

The integration test `does not let two users jointly strand a seat in the same row` fires
those two conflicting requests simultaneously and asserts one wins and one is rejected.

### 2. Holds must expire without a job being trustworthy

The seat-map query joins reservations with
`(status = 'booked' OR (status = 'held' AND expires_at > now()))`. Expiry is therefore a
property of every read, not the outcome of a job that might be stopped, lagging or crashed.

`jobs/maintenance.ts` still runs every 15 seconds, but only to flip lapsed rows to
`expired` so they drop out of the partial unique index and the seats become insertable again.
If it stopped, users would still see correct seat states, and the in-transaction reap in
`createHold` would still free seats on demand. Housekeeping, not mechanism.

The same job keeps the screening programme stocked. Showtimes go stale with the wall clock,
so seeding only at startup leaves a long-running container with nothing left to sell once its
last showing has begun — the demo would look broken without anything actually being wrong.
`ensureUpcomingScreenings` schedules a fresh programme whenever the hall has nothing in the
next 24 hours. A real cinema schedules its own programme, so this is demo-data upkeep and is
gated behind `RUN_SEED`.

### 3. The selection rules must be enforced server-side

`packages/shared/src/seatRules.ts` is a pure function over one row. The API calls it inside
the reservation transaction, under the row lock, against freshly read state — that is the
authoritative check, and since every click is a round trip it is also the only one. The
client does not second-guess it: the reason it shows the user is the reason the server gave.

The module stays in `packages/shared` because it is the vocabulary both sides speak, but
there is only one caller with authority.

## Request flow for the first seat

```
POST /api/screenings/:id/reservations  { seatIds: [42] }
  │
  ├─ requireAuth                       verify JWT
  ├─ zod                               shape of the payload
  └─ BEGIN
       ├─ load screening
       ├─ has it already started?                            → 409 SCREENING_STARTED
       ├─ resolve seat ids → row/seat numbers, reject seats from another hall
       ├─ Rule 1a: all seats in one row                      → 422 MULTIPLE_ROWS
       ├─ pg_advisory_xact_lock(screening_id, row_index)     ← serialise this row
       ├─ reap holds in this screening whose time has passed
       ├─ read the row's current occupancy
       ├─ validateSeatSelection(...)                          → 422 / 409
       ├─ INSERT reservations (expires_at = now() + 15 min)
       └─ INSERT reservation_seats                            → 23505 becomes 409
     COMMIT
```

## Request flow for every seat after it

```
POST /api/reservations/:id/seats  { seatId: 43 }        (DELETE .../seats/43 mirrors it)
  │
  └─ BEGIN
       ├─ SELECT the reservation FOR UPDATE                  ← serialise this customer's
       │    ├─ not yours?                          → 404       own rapid clicks
       │    ├─ booked / cancelled?                 → 409
       │    └─ lapsed, by the database clock?      → 409 HOLD_EXPIRED
       ├─ load the seats it already holds
       ├─ same row as those?                                 → 422 MULTIPLE_ROWS
       ├─ pg_advisory_xact_lock(screening_id, row_index)
       ├─ reap holds in this screening whose time has passed
       ├─ read the row, discounting this reservation's own seats
       ├─ validateSeatSelection(existing + new)               → 422 / 409
       └─ INSERT one reservation_seats row                    → 23505 becomes 409
     COMMIT                                                     expires_at is never touched
```

Both locks are always taken in that order — the reservation row first, the advisory lock
second — so the two paths cannot form a deadlock cycle.

## Interpreting Rule 2

The rule says a selection "must not leave a single empty seat trapped between occupied
seats". Taken literally as a check on the resulting layout, a row that _already_ contains a
trapped seat — which happens naturally when a hold expires or a booking is cancelled — would
reject every subsequent selection in that row, making those seats permanently unsellable.

So the implementation compares the row before and after: a trap the selection **creates** is
rejected; a pre-existing trap that the selection does not touch is not held against the user.
Every worked example in the specification behaves as written, and the tests assert all
three of them plus the pre-existing-gap case.

## Selecting _is_ holding

A seat becomes Reserved on the click that selects it. There is no pending, browser-only
selection and no commit step: the selection **is** a hold, and the client edits it one seat
at a time through `POST /reservations/:id/seats` and `DELETE /reservations/:id/seats/:seatId`.

Three consequences follow, and each is handled explicitly rather than left implicit.

**One clock, owned by the selection.** The countdown starts with the first seat and is never
touched again — `addSeatToHold` deliberately leaves `expires_at` alone. A selection that
grows for five minutes has ten minutes left, not fifteen. The corollary is that a user who
deselects everything and starts again does get a fresh fifteen minutes; closing that would
mean tracking released holds per user, which buys little against a cost that only a
deliberate camper pays.

**Both rules are re-checked on every edit, in both directions.** They are statements about
the finished run, not about individual clicks, so `addSeatToHold` and `removeSeatFromHold`
validate the _whole_ resulting selection rather than the delta. Giving a seat back is
therefore refusable: dropping one out of the middle would break Rule 1, and dropping one off
the end can strand its neighbour under Rule 2. Both are refused with a reason instead of
being silently repaired.

Releasing the _entire_ reservation is never refused, even when it leaves a seat stranded.
That asymmetry is deliberate: a customer must always be able to give everything back, and
the seat they strand is exactly the pre-existing gap that Rule 2 already forgives the next
person for. It also means every refusal above has an escape hatch, which is what the wording
of those errors points at.

**Click order can matter.** Someone who wants `5, 6, 7` in a row where seat 4 is already
taken has to start at 5: clicking 6 first passes through the intermediate state `4, 6`,
which strands seat 5, and is refused. The same three seats are reachable, but not by every
route to them. Enforcing at every step is still the right trade: the refusal arrives on the
click that caused it, with the row diagram and a suggestion, whereas deferring Rule 2 to a
commit step would move the rejection to the least useful moment — after the user believes
they have finished.

The write traffic this creates lands on the row that is already the contention point, which
is precisely why the advisory lock is per `(screening, row)` rather than anything coarser.

**What is not bounded.** Nothing limits how many live holds one customer may have on one
screening: a second tab starts a second selection, with its own row and its own clock. The
seat cap is per reservation, so it does not bound the total either. That was true before
seats became reservable on click, but clicking makes it effortless rather than deliberate,
and a real box office would want a per-customer cap here.

## A screening that has started cannot be sold

`listScreenings` returns only screenings whose `starts_at` is still in the future, and
`createHold` re-checks the same condition against the database clock inside the transaction.
The first is a convenience for clients; the second is the enforcement. A rule that exists
only in the read path is not a rule, merely a suggestion that well-behaved clients follow.

Confirming an _existing_ hold is deliberately still allowed after the film starts: the seats
were taken while they were on sale, and completing a purchase already in progress is the
behaviour a customer expects.

## Writes carry their own preconditions

`confirmHold` and `cancelHold` are single `UPDATE ... WHERE ... RETURNING` statements. Every
precondition — the reservation is yours, it is still `held`, it has not expired — lives in the
`WHERE` clause, so the statement is atomic on its own: no explicit transaction, no
`SELECT ... FOR UPDATE`, and no window between checking and writing.

When the update matches nothing, we read the row once, purely to produce a useful error
(`404` if it is not yours, `409 HOLD_EXPIRED` if it lapsed). That read is on the failure path
only, so the ordinary case is one round trip. Confirming or releasing twice is a no-op rather
than an error, which makes both endpoints safe to retry.

The three seat-level writes — `createHold`, `addSeatToHold`, `removeSeatFromHold` — are the
exception and do need a transaction: each validates a whole cinema row and then writes, and
those two steps must be seen as one.

## Error contract

Every non-2xx response is `{ error: { code, message, details? } }`.

| Status | Meaning              | Examples                                                                |
| ------ | -------------------- | ----------------------------------------------------------------------- |
| 400    | Malformed request    | `VALIDATION_FAILED`                                                     |
| 401    | Not signed in        | `INVALID_CREDENTIALS`, `TOKEN_EXPIRED`                                  |
| 404    | Absent, or not yours | `RESERVATION_NOT_FOUND`                                                 |
| 409    | The world moved on   | `SEAT_UNAVAILABLE`, `HOLD_EXPIRED`, `SCREENING_STARTED`                 |
| 422    | You broke a rule     | `NOT_CONSECUTIVE`, `MULTIPLE_ROWS`, `ISOLATED_SEAT`, `SEAT_NOT_AT_EDGE` |

The 409/422 split is deliberate: 409 means "the world moved, refresh and retry", 422 means "this
selection is not allowed no matter when you send it". The client treats them differently —
409 re-reads the seat map before showing the reason, 422 just explains the rule. Either way
the click leaves the reservation exactly as it was.

Rule violations carry a `details.diagram` such as `# # . * * . . . . .`, in the same notation
used throughout. It is rendered in the UI and asserted in tests.

## Dependencies: what we use, and what we deliberately wrote

The rule applied here: **reach for a library when the problem is genuinely solved and the
failure modes are subtle; write the code when it is the thing being assessed.**

Leaning on a package:

| Package                                                      | Replaces                       | Why                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------ | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@tanstack/react-query`                                      | A hand-rolled polling hook     | Polling, pausing in a background tab, refetch on focus, request de-duplication, cancellation and stale-response handling are each individually easy and collectively a source of quiet bugs. Keying the cache by screening id makes the stale-response problem structurally impossible rather than guarded against. |
| `node-pg-migrate`                                            | A hand-rolled migration runner | A ledger table, per-migration transactions, ordering checks and an advisory lock so two replicas cannot migrate at once. Migrations stay plain `.sql`, and we gained a real `down`.                                                                                                                                 |
| `express-rate-limit`                                         | Nothing — this was a gap       | Credential-stuffing protection with correct `RateLimit` headers. `skipSuccessfulRequests` means only failed sign-ins count, so a legitimate user is never locked out by their own success.                                                                                                                          |
| `zod`                                                        | Hand-written validators        | Request bodies and environment configuration, with the parsed type inferred rather than restated.                                                                                                                                                                                                                   |
| `eslint` + `typescript-eslint` + `eslint-plugin-react-hooks` | Review vigilance               | The React Compiler rules caught seven real defects on first run — `setState` inside effects, and an impure `Date.now()` during render. That class of bug is invisible in review and shows up only as a wrong screen.                                                                                                |
| `helmet`, `cors`, `pino`, `bcryptjs`, `jsonwebtoken`         | —                              | Unremarkable, correct, boring. Exactly right.                                                                                                                                                                                                                                                                       |

Deliberately **not** using a package:

- **No ORM, and no query builder (Prisma / Drizzle / Kysely).** The interesting parts of
  this system are a partial unique index, an advisory lock, and a lateral join. An ORM hides
  precisely those. Kysely was the closest call — it is a type-safe builder rather than an
  ORM, and would remove the hand-written row interfaces — but it would mean rewriting every
  query with `sql` escape hatches at each of the interesting points, which is churn without
  a payoff at this size.
- **No toast library.** `sonner` would do it, but the toast here is a styled part of the
  ticket-stub design and the state involved is about forty lines.
- **No `axios`, `date-fns` or `lodash`.** `fetch`, `Intl` and the standard library cover
  every use in this codebase. Each would be a dependency carrying weight for nothing.
- **No `passport`.** One JWT strategy is a fifteen-line middleware; Passport's value is in
  having many strategies.

## Deliberate omissions

Worth naming, since they were choices rather than oversights:

- **Polling, not WebSockets.** The client re-reads the seat map every 4 seconds and on tab
  focus. A socket would be the right answer at higher contention; for one hall it adds a
  stateful connection, reconnection logic and a scaling constraint for a barely different
  user experience.
- **No payment step.** "Complete a reservation" is modelled as `held → booked`. A payment
  provider would sit between them and change nothing structural.
- **JWT in `localStorage`.** Simple and appropriate at this scale. Production would use
  an httpOnly, SameSite cookie with a refresh token to remove the XSS token-theft surface.
- **Rate limiting is in-memory.** Correct for a single instance; more than one replica needs
  a shared store (`rate-limit-redis`), which is a deployment decision rather than a code one.
