/** Seat status as presented to the user. Derived server-side, never stored on the seat itself. */
export type SeatStatus = 'available' | 'reserved' | 'booked';

/** Lifecycle of a reservation aggregate. Mirrored onto `reservation_seats` by a DB trigger. */
export type ReservationStatus = 'held' | 'booked' | 'expired' | 'cancelled';

export interface PublicUser {
  id: number;
  email: string;
  displayName: string;
}

export interface AuthResponse {
  token: string;
  /** Unix epoch milliseconds at which the token stops being accepted. */
  expiresAt: number;
  user: PublicUser;
}

export interface Screening {
  id: number;
  startsAt: string;
  auditoriumId: number;
  auditoriumName: string;
  movieId: number;
  movieTitle: string;
  movieDurationMinutes: number;
}

export interface SeatView {
  id: number;
  rowLabel: string;
  rowIndex: number;
  seatNumber: number;
  status: SeatStatus;
  /** True when the current user owns the hold/booking occupying this seat. */
  mine: boolean;
  /** Present only for seats the current user holds. ISO-8601. */
  holdExpiresAt: string | null;
}

export interface SeatMapRow {
  label: string;
  index: number;
  seatCount: number;
  seats: SeatView[];
}

export interface SeatMap {
  screening: Screening;
  rows: SeatMapRow[];
  /** Server clock at the moment the map was produced, so clients can correct for drift. */
  serverTime: string;
  totals: {
    available: number;
    reserved: number;
    booked: number;
  };
}

export interface ReservationSeatSummary {
  seatId: number;
  rowLabel: string;
  seatNumber: number;
}

export interface Reservation {
  id: string;
  screeningId: number;
  status: ReservationStatus;
  createdAt: string;
  expiresAt: string;
  confirmedAt: string | null;
  seats: ReservationSeatSummary[];
}

/** Every non-2xx response from the API uses this envelope. */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}
