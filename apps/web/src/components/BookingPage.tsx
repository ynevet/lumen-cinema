import { useCallback, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { Reservation } from '@lumen/shared';
import { ApiError, api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useSeatMap } from '../hooks/useSeatMap';
import { useSeatSelection } from '../hooks/useSeatSelection';
import { useToast } from './Toasts';
import { SeatMapView } from './SeatMapView';
import { HoldCard } from './HoldCard';

const FALLBACK_SETTINGS = { holdMinutes: 15, maxSeatsPerReservation: 10 };

function formatShowtime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
}

function seatList(seats: Reservation['seats']): string {
  return seats.map((seat) => `${seat.rowLabel}${seat.seatNumber}`).join(', ');
}

export function BookingPage() {
  const { user, signOut } = useAuth();
  const toast = useToast();
  const [chosenId, setChosenId] = useState<number | null>(null);

  // Hold rules and duration come from the server so the UI never hard-codes them.
  const settingsQuery = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.settings(),
    staleTime: Infinity,
  });
  const settings = settingsQuery.data ?? FALLBACK_SETTINGS;

  const screeningsQuery = useQuery({
    queryKey: ['screenings'],
    queryFn: () => api.screenings().then((result) => result.screenings),
    staleTime: 60_000,
  });
  const screenings = screeningsQuery.data ?? [];

  // Default to the next showing until the user picks one - derived, so no effect and no
  // render pass where the page has screenings but nothing selected.
  const screeningId = chosenId ?? screenings[0]?.id ?? null;

  const { seatMap, reservations, loading, stale, refresh } = useSeatMap(screeningId);
  const selection = useSeatSelection(seatMap, screeningId, settings.maxSeatsPerReservation);

  const reportFailure = useCallback(
    async (error: unknown) => {
      if (!(error instanceof ApiError)) return;
      const details = error.details as { diagram?: string } | undefined;
      toast.push({ tone: 'error', message: error.message, diagram: details?.diagram });
      // The world moved underneath us - show what it looks like now.
      if (error.status === 409) await refresh();
    },
    [refresh, toast],
  );

  const hold = useMutation({
    mutationFn: (seatIds: number[]) => api.hold(screeningId as number, seatIds),
    onSuccess: async ({ reservation }) => {
      selection.clear();
      await refresh();
      toast.push({
        tone: 'success',
        message: `Holding ${seatList(reservation.seats)} for ${settings.holdMinutes} minutes.`,
      });
    },
    onError: reportFailure,
  });

  const confirm = useMutation({
    mutationFn: (reservationId: string) => api.confirm(reservationId),
    onSuccess: async ({ reservation }) => {
      await refresh();
      toast.push({
        tone: 'success',
        message: `Booked ${seatList(reservation.seats)}. Enjoy the film.`,
      });
    },
    onError: reportFailure,
  });

  const release = useMutation({
    mutationFn: (reservationId: string) => api.release(reservationId),
    onSuccess: async () => {
      await refresh();
      toast.push({ tone: 'info', message: 'Seats released.' });
    },
    onError: reportFailure,
  });

  const handleExpire = useCallback(() => {
    toast.push({ tone: 'info', message: 'A hold ran out and those seats went back on sale.' });
    void refresh();
  }, [refresh, toast]);

  const busy = hold.isPending || confirm.isPending || release.isPending;
  const screening = seatMap?.screening;
  const blockedByRule = selection.preflight !== null && !selection.preflight.ok;

  // The server already returns only live holds and bookings (`?active=true`). A hold that
  // lapses between polls is handled by its own countdown, which disables Confirm at zero
  // and calls `onExpire` to refresh - so no clock reading is needed during render.
  const liveHolds = reservations.filter(
    (item) => item.status === 'booked' || item.status === 'held',
  );

  if (screeningsQuery.isError) {
    return (
      <div className="center-note">
        <p>Cannot reach the box office.</p>
      </div>
    );
  }

  if (screeningsQuery.isSuccess && screenings.length === 0) {
    return (
      <div className="center-note">
        <p>No screenings are scheduled.</p>
      </div>
    );
  }

  return (
    <div className="hall">
      <header className="topbar">
        <div className="topbar__brand marquee-word">
          Lumen <span>Cinema</span>
        </div>
        <div className="topbar__spacer" />
        <div className="topbar__user">
          <div className="topbar__user-name">{user?.displayName}</div>
          <div className="eyebrow">{user?.email}</div>
        </div>
        <button type="button" className="btn btn--ghost" onClick={signOut}>
          Sign out
        </button>
      </header>

      <main className="stage">
        <section>
          <p className="eyebrow" style={{ marginBottom: 10 }}>
            Next at Hall 1
          </p>
          <div className="showings" role="group" aria-label="Choose a screening">
            {screenings.map((item) => (
              <button
                key={item.id}
                type="button"
                className="showing"
                aria-pressed={item.id === screeningId}
                onClick={() => setChosenId(item.id)}
              >
                <div className="showing__time">{formatShowtime(item.startsAt)}</div>
                <div className="showing__title">{item.movieTitle}</div>
              </button>
            ))}
          </div>

          {loading && !seatMap ? (
            <div className="center-note">
              <div className="spinner" aria-hidden="true" />
              <p>Reading the seat plan…</p>
            </div>
          ) : seatMap ? (
            // Remounting per screening replays the entry animation exactly once.
            <SeatMapView
              key={screeningId}
              seatMap={seatMap}
              selected={new Set(selection.selected)}
              onToggleSeat={selection.toggle}
            />
          ) : null}

          {stale ? (
            <p className="tally" role="status">
              Lost contact with the box office. Retrying…
            </p>
          ) : null}
        </section>

        <aside className="rail">
          <div className="stub ticket">
            <p className="eyebrow">Your ticket</p>
            <h2 className="ticket__film">{screening?.movieTitle ?? '—'}</h2>
            <p className="ticket__meta">
              {screening ? formatDay(screening.startsAt) : '—'} ·{' '}
              {screening ? formatShowtime(screening.startsAt) : '—'}
              <br />
              {screening?.auditoriumName ?? '—'} · {screening?.movieDurationMinutes ?? '—'} min
            </p>

            <div className="ticket__tear" />

            {selection.labels.length > 0 ? (
              <>
                <p className="eyebrow">
                  {selection.labels.length} seat{selection.labels.length > 1 ? 's' : ''} selected
                </p>
                <div className="ticket__seats">
                  {selection.labels.map((label) => (
                    <span key={label} className="seat-chip">
                      {label}
                    </span>
                  ))}
                </div>
              </>
            ) : (
              <p className="ticket__empty">
                Pick a seat on the plan. Seats in one booking must sit side by side in the same row.
              </p>
            )}

            {selection.preflight && !selection.preflight.ok ? (
              <p className="ticket__notice" role="alert">
                {selection.preflight.violation.message}
                {selection.preflight.violation.diagram ? (
                  <code>{selection.preflight.violation.diagram}</code>
                ) : null}
              </p>
            ) : null}

            <div className="ticket__actions">
              <button
                type="button"
                className="btn btn--paper"
                disabled={busy || selection.selected.length === 0 || blockedByRule}
                onClick={() => hold.mutate(selection.selected)}
              >
                Hold for {settings.holdMinutes} min
              </button>
              {selection.selected.length > 0 ? (
                <button
                  type="button"
                  className="btn btn--paper-ghost"
                  onClick={selection.clear}
                  disabled={busy}
                >
                  Clear
                </button>
              ) : null}
            </div>
          </div>

          {liveHolds.length > 0 ? (
            <div className="holds">
              {liveHolds.map((reservation) => (
                <HoldCard
                  key={reservation.id}
                  reservation={reservation}
                  holdMinutes={settings.holdMinutes}
                  onConfirm={confirm.mutate}
                  onRelease={release.mutate}
                  onExpire={handleExpire}
                  busy={busy}
                />
              ))}
            </div>
          ) : null}
        </aside>
      </main>
    </div>
  );
}
