# Architecture

## Shape of the repository

```
lumen-cinema/
├── packages/shared/        @lumen/shared - types + seat-selection rules
├── apps/api/               @lumen/api    - Express 5 + TypeScript + node-postgres
│   └── db/migrations/      versioned SQL, applied at startup
├── apps/web/               @lumen/web    - React 19 + Vite
├── docs/                   ERD, this document
└── docker-compose.yml      db + api + web
```

npm workspaces, one lockfile, one TypeScript project graph. `@lumen/shared` is a real
package rather than a folder of copied files, which is what allows the seat rules to be
literally the same code on both sides of the wire.

## The three problems worth solving

Everything else in this project is CRUD. These three are not.

### 1. Two users must never get the same seat

Three layers, from strongest to weakest:

**A partial unique index.** `reservation_seats` may hold at most one row per
`(screening_id, seat_id)` whose status is `held` or `booked`. Concurrent inserts collide in
the index; one commits, the other gets SQLSTATE `23505` and becomes a `409`. This holds
regardless of how many API processes run, and regardless of whether anyone remembered to
take a lock.

**A per-row advisory lock**, `pg_advisory_xact_lock(screening_id, row_index)`. Rule 2 is a
statement about a whole cinema row, so two transactions that read the row at the same moment
could each pass validation and *together* strand a seat — a race the unique index cannot see,
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

`jobs/expirySweeper.ts` still runs every 15 seconds, but only to flip lapsed rows to
`expired` so they drop out of the partial unique index and the seats become insertable again.
If it stopped, users would still see correct seat states, and the in-transaction reap in
`createHold` would still free seats on demand. Housekeeping, not mechanism.

### 3. The selection rules must be enforced server-side and feel instant

`packages/shared/src/seatRules.ts` is a pure function over one row. The API calls it inside
the reservation transaction, under the row lock, against freshly read state — that is the
authoritative check. The web client calls the same function on every click to disable the
Hold button and explain why, so the user never submits something that will be refused.

There is no second implementation to keep in sync, and the client's copy has no authority.

## Request flow for a hold

```
POST /api/screenings/:id/reservations  { seatIds: [42, 43] }
  │
  ├─ requireAuth                       verify JWT
  ├─ zod                               shape of the payload
  └─ BEGIN
       ├─ load screening
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

## Interpreting Rule 2

The brief says a selection "must not leave a single empty seat trapped between occupied
seats". Taken literally as a check on the resulting layout, a row that *already* contains a
trapped seat — which happens naturally when a hold expires or a booking is cancelled — would
reject every subsequent selection in that row, making those seats permanently unsellable.

So the implementation compares the row before and after: a trap the selection **creates** is
rejected; a pre-existing trap that the selection does not touch is not held against the user.
Every worked example in the specification behaves exactly as specified, and the tests assert all
three of them plus the pre-existing-gap case.

## Error contract

Every non-2xx response is `{ error: { code, message, details? } }`.

| Status | Meaning | Examples |
| --- | --- | --- |
| 400 | Malformed request | `VALIDATION_FAILED` |
| 401 | Not signed in | `INVALID_CREDENTIALS`, `TOKEN_EXPIRED` |
| 404 | Absent, or not yours | `RESERVATION_NOT_FOUND` |
| 409 | You lost a race | `SEAT_UNAVAILABLE`, `HOLD_EXPIRED` |
| 422 | You broke a rule | `NOT_CONSECUTIVE`, `MULTIPLE_ROWS`, `ISOLATED_SEAT` |

The 409/422 split is deliberate: 409 means "try again, the world moved", 422 means "this
selection is not allowed no matter when you send it". The client treats them differently —
409 clears the selection and refreshes, 422 explains the rule.

Rule violations carry a `details.diagram` such as `# # . * * . . . . .`, in the same notation
the specification uses. It is rendered in the UI and asserted in tests.

## Deliberate omissions

Worth naming, since they were choices rather than oversights:

- **No ORM.** The interesting parts of this system are a partial unique index, an advisory
  lock and a lateral join. Those are the things an ORM hides.
- **Polling, not WebSockets.** The client re-reads the seat map every 4 seconds and on tab
  focus. A socket would be the right answer at higher contention; for one hall it adds a
  stateful connection, reconnection logic and a scaling constraint for a barely different
  user experience.
- **No payment step.** "Complete a reservation" is modelled as `held → booked`. A payment
  provider would sit between them and change nothing structural.
- **JWT in `localStorage`.** Simple and appropriate for this scale. Production would use
  an httpOnly, SameSite cookie with a refresh token to remove the XSS token-theft surface.
- **No rate limiting.** Would be the first thing added before exposing this to the internet.
