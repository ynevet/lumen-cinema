import { useCallback, useEffect, useState } from 'react';
import type { Screening } from '@lumen/shared';
import { ApiError, api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useSeatMap } from '../hooks/useSeatMap';
import { useSeatSelection } from '../hooks/useSeatSelection';
import { useToast } from './Toasts';
import { SeatMapView } from './SeatMapView';
import { HoldCard } from './HoldCard';

interface Settings {
  holdMinutes: number;
  maxSeatsPerReservation: number;
}

const FALLBACK_SETTINGS: Settings = { holdMinutes: 15, maxSeatsPerReservation: 10 };

function formatShowtime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
}

export function BookingPage() {
  const { user, signOut } = useAuth();
  const toast = useToast();

  const [settings, setSettings] = useState<Settings>(FALLBACK_SETTINGS);
  const [screenings, setScreenings] = useState<Screening[]>([]);
  const [screeningId, setScreeningId] = useState<number | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const { seatMap, reservations, loading, error, refresh } = useSeatMap(screeningId);
  const selection = useSeatSelection(seatMap, screeningId, settings.maxSeatsPerReservation);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.settings(), api.screenings()])
      .then(([config, { screenings: list }]) => {
        if (cancelled) return;
        setSettings(config);
        setScreenings(list);
        setScreeningId((current) => current ?? list[0]?.id ?? null);
        if (list.length === 0) setFatal('No screenings are scheduled.');
      })
      .catch((caught: unknown) => {
        if (!cancelled && caught instanceof ApiError && caught.status !== 401) {
          setFatal('Cannot reach the box office.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /** Every action follows the same shape: run it, re-read, say what happened. */
  const run = useCallback(
    async (action: () => Promise<string>) => {
      setBusy(true);
      try {
        const message = await action();
        await refresh();
        toast.push({ tone: 'success', message });
      } catch (caught) {
        if (caught instanceof ApiError) {
          const details = caught.details as { diagram?: string } | undefined;
          toast.push({ tone: 'error', message: caught.message, diagram: details?.diagram });
          // The world moved underneath us - show what it looks like now.
          if (caught.status === 409) await refresh().catch(() => undefined);
        }
      } finally {
        setBusy(false);
      }
    },
    [refresh, toast],
  );

  const seatList = (seats: { rowLabel: string; seatNumber: number }[]): string =>
    seats.map((seat) => `${seat.rowLabel}${seat.seatNumber}`).join(', ');

  const handleHold = () =>
    run(async () => {
      const { reservation } = await api.hold(screeningId!, selection.selected);
      selection.clear();
      return `Holding ${seatList(reservation.seats)} for ${settings.holdMinutes} minutes.`;
    });

  const handleConfirm = (reservationId: string) =>
    run(async () => {
      const { reservation } = await api.confirm(reservationId);
      return `Booked ${seatList(reservation.seats)}. Enjoy the film.`;
    });

  const handleRelease = (reservationId: string) =>
    run(async () => {
      await api.release(reservationId);
      return 'Seats released.';
    });

  const handleExpire = useCallback(() => {
    toast.push({ tone: 'info', message: 'A hold ran out and those seats went back on sale.' });
    void refresh().catch(() => undefined);
  }, [refresh, toast]);

  const screening = seatMap?.screening;
  const now = Date.now();
  const liveHolds = reservations.filter(
    (item) =>
      item.status === 'booked' ||
      (item.status === 'held' && new Date(item.expiresAt).getTime() > now),
  );

  const blockedByRule = selection.preflight !== null && !selection.preflight.ok;

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

      {fatal ? (
        <div className="center-note">
          <p>{fatal}</p>
        </div>
      ) : (
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
                  onClick={() => setScreeningId(item.id)}
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

            {error ? (
              <p className="tally" role="status">
                {error} Retrying…
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
                  Pick a seat on the plan. Seats in one booking must sit side by side in the same
                  row.
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
                  onClick={handleHold}
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
                    onConfirm={handleConfirm}
                    onRelease={handleRelease}
                    onExpire={handleExpire}
                    busy={busy}
                  />
                ))}
              </div>
            ) : null}
          </aside>
        </main>
      )}
    </div>
  );
}
