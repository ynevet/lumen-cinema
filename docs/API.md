# API and configuration

Everything is under `/api`. Every route except `/auth/*`, `/health` and `/config` needs an
`Authorization: Bearer <jwt>` header.

## Endpoints

| Method   | Path                              | Purpose                                                       |
| -------- | --------------------------------- | ------------------------------------------------------------- |
| `POST`   | `/auth/register`                  | Create an account, returns a token                            |
| `POST`   | `/auth/login`                     | Sign in                                                       |
| `GET`    | `/auth/me`                        | Verify a stored token                                         |
| `GET`    | `/config`                         | Hold duration and seat cap, so the UI does not hard-code them |
| `GET`    | `/health`                         | Liveness plus database reachability                           |
| `GET`    | `/screenings`                     | Upcoming showtimes                                            |
| `GET`    | `/screenings/:id/seatmap`         | The seating map with every seat's status                      |
| `POST`   | `/screenings/:id/reservations`    | Reserve seats, starting the clock — `{ seatIds: number[] }`   |
| `GET`    | `/screenings/:id/reservations`    | Your reservations here; `?active=true` for live ones          |
| `POST`   | `/reservations/:id/seats`         | Add one seat — `{ seatId }`. Does **not** extend the clock    |
| `DELETE` | `/reservations/:id/seats/:seatId` | Give one seat back; the last one releases the reservation     |
| `POST`   | `/reservations/:id/confirm`       | Complete the reservation: held → booked                       |
| `DELETE` | `/reservations/:id`               | Release a hold early                                          |

The first seat of a selection goes through `POST /screenings/:id/reservations`, which opens
the hold and starts its 15 minutes. Every seat after that is a `POST` or `DELETE` on that
reservation's `seats`, and neither ever moves `expires_at`.

Try it from the command line:

```bash
TOKEN=$(curl -s localhost:4000/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"alice@example.com","password":"Password123!"}' | jq -r .token)

curl -s localhost:4000/api/screenings -H "authorization: Bearer $TOKEN" | jq
```

## Errors

Always `{ error: { code, message, details? } }`.

| Status | Meaning              | Examples                                                                |
| ------ | -------------------- | ----------------------------------------------------------------------- |
| 400    | Malformed request    | `VALIDATION_FAILED`                                                     |
| 401    | Not signed in        | `INVALID_CREDENTIALS`, `TOKEN_EXPIRED`                                  |
| 404    | Absent, or not yours | `RESERVATION_NOT_FOUND`                                                 |
| 409    | The world moved on   | `SEAT_UNAVAILABLE`, `HOLD_EXPIRED`, `SCREENING_STARTED`                 |
| 422    | You broke a rule     | `NOT_CONSECUTIVE`, `MULTIPLE_ROWS`, `ISOLATED_SEAT`, `SEAT_NOT_AT_EDGE` |

`409` means refresh and try again; `422` means the selection is not allowed no matter when
you send it. Rule violations carry a `details.diagram` such as `# # . * * . . . . .`.

## Configuration

Every value has a working default and `docker compose` supplies its own, so `.env` is only
needed when running outside Docker. See [`.env.example`](../.env.example).

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

Sign-in is rate limited to 20 **failed** attempts per IP per 15 minutes; successful
sign-ins are not counted, so ordinary use is never throttled. The rest of the API has a
deliberately generous backstop of 1500 requests per IP per 15 minutes.

Setting `HOLD_MINUTES=1` is the quickest way to watch a hold expire:

```bash
HOLD_MINUTES=1 docker compose up --build
```
