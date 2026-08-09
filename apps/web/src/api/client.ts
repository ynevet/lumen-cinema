import type {
  ApiErrorBody,
  AuthResponse,
  PublicUser,
  Reservation,
  SeatMap,
  Screening,
} from '@lumen/shared';

const TOKEN_KEY = 'cinema.token';

/** Carries the server's error envelope so the UI can react to specific codes. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, body: ApiErrorBody | null, fallback: string) {
    super(body?.error?.message ?? fallback);
    this.name = 'ApiError';
    this.status = status;
    this.code = body?.error?.code ?? 'UNKNOWN';
    this.details = body?.error?.details;
  }
}

export const tokenStore = {
  get: (): string | null => localStorage.getItem(TOKEN_KEY),
  set: (token: string): void => localStorage.setItem(TOKEN_KEY, token),
  clear: (): void => localStorage.removeItem(TOKEN_KEY),
};

/** Fired when the server rejects our token, so the app can drop back to the login screen. */
export const onUnauthorized = new EventTarget();

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  options: { auth?: boolean } = { auth: true },
): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';

  const token = tokenStore.get();
  if (options.auth !== false && token) headers.authorization = `Bearer ${token}`;

  const response = await fetch(`/api${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  if (response.status === 204) return undefined as T;

  const payload = (await response.json().catch(() => null)) as unknown;

  if (!response.ok) {
    if (response.status === 401 && options.auth !== false) {
      onUnauthorized.dispatchEvent(new Event('unauthorized'));
    }
    throw new ApiError(response.status, payload as ApiErrorBody | null, response.statusText);
  }

  return payload as T;
}

export const api = {
  login: (email: string, password: string) =>
    request<AuthResponse>('POST', '/auth/login', { email, password }, { auth: false }),

  register: (input: { email: string; displayName: string; password: string }) =>
    request<AuthResponse>('POST', '/auth/register', input, { auth: false }),

  me: () => request<{ user: PublicUser }>('GET', '/auth/me'),

  settings: () =>
    request<{ holdMinutes: number; maxSeatsPerReservation: number }>('GET', '/config', undefined, {
      auth: false,
    }),

  screenings: () => request<{ screenings: Screening[] }>('GET', '/screenings'),

  seatMap: (screeningId: number) => request<SeatMap>('GET', `/screenings/${screeningId}/seatmap`),

  myReservations: (screeningId: number) =>
    request<{ reservations: Reservation[] }>('GET', `/screenings/${screeningId}/reservations`),

  hold: (screeningId: number, seatIds: number[]) =>
    request<{ reservation: Reservation }>('POST', `/screenings/${screeningId}/reservations`, {
      seatIds,
    }),

  confirm: (reservationId: string) =>
    request<{ reservation: Reservation }>('POST', `/reservations/${reservationId}/confirm`),

  release: (reservationId: string) =>
    request<{ reservation: Reservation }>('DELETE', `/reservations/${reservationId}`),
};
