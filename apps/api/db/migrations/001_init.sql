-- Up Migration
-- ============================================================================
-- 001_init - cinema reservation schema
-- ============================================================================
-- Design notes
--
-- * Seat status (Available / Reserved / Booked) is NEVER stored on the seat. It is
--   derived from the reservation that currently occupies the seat, which keeps the
--   seat table immutable reference data and makes "expired holds free the seat"
--   a consequence of the data model rather than a background job we must trust.
--
-- * `reservation_seats` carries a denormalised `screening_id` and a mirrored
--   `status`. That is deliberate: it lets a single PARTIAL UNIQUE INDEX enforce
--   "at most one active occupant per (screening, seat)" inside the database. That
--   index - not application code - is what makes double booking impossible.
--
-- * The mirrored status is kept in sync by a trigger, so it cannot drift.
-- ============================================================================

CREATE TYPE reservation_status AS ENUM ('held', 'booked', 'expired', 'cancelled');

-- ----------------------------------------------------------------------------
-- Identity
-- ----------------------------------------------------------------------------
CREATE TABLE users (
    id            INTEGER     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email         TEXT        NOT NULL,
    display_name  TEXT        NOT NULL,
    password_hash TEXT        NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT users_email_not_blank CHECK (length(btrim(email)) > 0)
);

-- Case-insensitive uniqueness without requiring the citext extension.
CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email));

-- ----------------------------------------------------------------------------
-- Venue reference data
-- ----------------------------------------------------------------------------
CREATE TABLE auditoriums (
    id         INTEGER     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name       TEXT        NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE seats (
    id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    auditorium_id INTEGER NOT NULL REFERENCES auditoriums (id) ON DELETE CASCADE,
    row_label     TEXT    NOT NULL,
    row_index     INTEGER NOT NULL,
    seat_number   INTEGER NOT NULL,
    CONSTRAINT seats_row_index_positive   CHECK (row_index   >= 1),
    CONSTRAINT seats_seat_number_positive CHECK (seat_number >= 1),
    CONSTRAINT seats_unique_in_auditorium UNIQUE (auditorium_id, row_label, seat_number),
    -- Needed so reservation_seats can prove, via a composite FK, that a seat really
    -- belongs to the auditorium the screening takes place in.
    CONSTRAINT seats_id_auditorium_key    UNIQUE (id, auditorium_id)
);

CREATE INDEX seats_auditorium_row_idx ON seats (auditorium_id, row_index, seat_number);

CREATE TABLE movies (
    id               INTEGER     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    title            TEXT        NOT NULL UNIQUE,
    duration_minutes INTEGER     NOT NULL,
    synopsis         TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT movies_duration_positive CHECK (duration_minutes > 0)
);

CREATE TABLE screenings (
    id            INTEGER     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    movie_id      INTEGER     NOT NULL REFERENCES movies (id)      ON DELETE RESTRICT,
    auditorium_id INTEGER     NOT NULL REFERENCES auditoriums (id) ON DELETE RESTRICT,
    starts_at     TIMESTAMPTZ NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- One auditorium cannot host two screenings at the same moment.
    CONSTRAINT screenings_slot_unique UNIQUE (auditorium_id, starts_at),
    -- Referenced by the composite FK on reservation_seats.
    CONSTRAINT screenings_id_auditorium_key UNIQUE (id, auditorium_id)
);

CREATE INDEX screenings_starts_at_idx ON screenings (starts_at);

-- ----------------------------------------------------------------------------
-- Reservations
-- ----------------------------------------------------------------------------
CREATE TABLE reservations (
    id           UUID               PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      INTEGER            NOT NULL REFERENCES users (id)      ON DELETE CASCADE,
    screening_id INTEGER            NOT NULL REFERENCES screenings (id) ON DELETE CASCADE,
    status       reservation_status NOT NULL DEFAULT 'held',
    created_at   TIMESTAMPTZ        NOT NULL DEFAULT now(),
    expires_at   TIMESTAMPTZ        NOT NULL,
    confirmed_at TIMESTAMPTZ,
    released_at  TIMESTAMPTZ,
    CONSTRAINT reservations_expiry_after_creation CHECK (expires_at > created_at),
    CONSTRAINT reservations_confirmed_iff_booked
        CHECK ((status = 'booked') = (confirmed_at IS NOT NULL))
);

CREATE INDEX reservations_user_idx      ON reservations (user_id, created_at DESC);
CREATE INDEX reservations_screening_idx ON reservations (screening_id);
-- Drives the expiry sweeper: only the small set of live holds is scanned.
CREATE INDEX reservations_active_holds_idx
    ON reservations (expires_at)
    WHERE status = 'held';

CREATE TABLE reservation_seats (
    reservation_id UUID               NOT NULL REFERENCES reservations (id) ON DELETE CASCADE,
    seat_id        INTEGER            NOT NULL REFERENCES seats (id)        ON DELETE RESTRICT,
    -- Denormalised from the parent reservation purely so the partial unique index
    -- below can exist. Kept correct by the composite FKs and the sync trigger.
    screening_id   INTEGER            NOT NULL,
    auditorium_id  INTEGER            NOT NULL,
    status         reservation_status NOT NULL,
    PRIMARY KEY (reservation_id, seat_id),
    -- The seat must live in the auditorium ...
    CONSTRAINT reservation_seats_seat_in_auditorium
        FOREIGN KEY (seat_id, auditorium_id) REFERENCES seats (id, auditorium_id),
    -- ... where this screening actually takes place. Together these make it
    -- impossible to book seat "row A / 3 of hall 2" for a screening in hall 1.
    CONSTRAINT reservation_seats_screening_in_auditorium
        FOREIGN KEY (screening_id, auditorium_id) REFERENCES screenings (id, auditorium_id)
);

-- ============================================================================
-- THE double-booking guard.
-- At most one row per (screening, seat) may be in an occupying state. Two
-- concurrent transactions inserting the same seat will collide here: one commits,
-- the other gets SQLSTATE 23505 and is translated into HTTP 409 by the API.
-- ============================================================================
CREATE UNIQUE INDEX reservation_seats_one_active_occupant
    ON reservation_seats (screening_id, seat_id)
    WHERE status IN ('held', 'booked');

CREATE INDEX reservation_seats_seat_idx ON reservation_seats (screening_id, seat_id);

-- ----------------------------------------------------------------------------
-- Keep the mirrored status honest.
-- ----------------------------------------------------------------------------
CREATE FUNCTION sync_reservation_seat_status() RETURNS TRIGGER AS $$
BEGIN
    UPDATE reservation_seats
       SET status = NEW.status
     WHERE reservation_id = NEW.id
       AND status IS DISTINCT FROM NEW.status;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER reservations_status_sync
    AFTER UPDATE OF status ON reservations
    FOR EACH ROW
    WHEN (OLD.status IS DISTINCT FROM NEW.status)
    EXECUTE FUNCTION sync_reservation_seat_status();

-- Down Migration
-- Dropped in dependency order; CASCADE would also work but naming each object
-- keeps the rollback explicit about what it destroys.
DROP TRIGGER IF EXISTS reservations_status_sync ON reservations;
DROP FUNCTION IF EXISTS sync_reservation_seat_status();

DROP TABLE IF EXISTS reservation_seats;
DROP TABLE IF EXISTS reservations;
DROP TABLE IF EXISTS screenings;
DROP TABLE IF EXISTS movies;
DROP TABLE IF EXISTS seats;
DROP TABLE IF EXISTS auditoriums;
DROP TABLE IF EXISTS users;

DROP TYPE IF EXISTS reservation_status;
