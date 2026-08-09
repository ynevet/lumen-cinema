import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Reservation, Screening, SeatMap, SeatMapRow, SeatView } from '@lumen/shared';
import { validateSeatSelection } from '@lumen/shared';
import { ApiError, api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useToast } from './Toasts';
import { SeatMapView } from './SeatMapView';
import { HoldCard } from './HoldCard';

/** How often we re-read the map so other people's seats appear without a refresh. */
const POLL_MS = 4000;

interface Settings {
  holdMinutes: number;
  maxSeatsPerReservation: number;
}

function formatShowtime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
}

export function BookingPage() {
  const { user, signOut } = useAuth();
  const toast = useToast();

  const [settings, setSettings] = useState<Settings>({ holdMinutes: 15, maxSeatsPerReservation: 10 });
  const [screenings, setScreenings] = useState<Screening[]>([]);
  const [screeningId, setScreeningId] = useState<number | null>(null);
  const [seatMap, setSeatMap] = useState<SeatMap | null>(null);
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);

  // Animate the grid only when the screening changes, not on every 4s poll.
  const animateKey = useRef<number | null>(null);
  const justSwitched = animateKey.current !== screeningId;

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
      .catch((error: unknown) => {
        if (!cancelled && error instanceof ApiError && error.status !== 401) {
          setFatal('Cannot reach the box office.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const refresh = useCallback(
    async (id: number) => {
      const [map, mine] = await Promise.all([api.seatMap(id), api.myReservations(id)]);
      setSeatMap(map);
      setReservations(mine.reservations);
      return map;
    },
    [],
  );

  // Poll while the tab is visible; a background tab does not need live seats.
  useEffect(() => {
    if (screeningId === null) return;
    let cancelled = false;

    // `force` is set for the initial load and for the visibility handler, so a tab
    // that starts in the background still fills in rather than spinning forever.
    const tick = async (force = false) => {
      if (document.hidden && !force) return;
      try {
        const map = await refresh(screeningId);
        if (cancelled) return;
        // Drop any pending selection that somebody else has taken in the meantime.
        setSelected((current) => {
          if (current.length === 0) return current;
          const stillFree = new Set(
            map.rows.flatMap((row) =>
              row.seats.filter((seat) => seat.status === 'available').map((seat) => seat.id),
            ),
          );
          const kept = current.filter((id) => stillFree.has(id));
          return kept.length === current.length ? current : kept;
        });
      } catch (error) {
        if (!cancelled && error instanceof ApiError && error.status !== 401) {
          setFatal('Lost contact with the box office.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    setLoading(true);
    setSelected([]);
    void tick(true);
    animateKey.current = screeningId;

    // Coming back to the tab should show current seats immediately, not in 4s.
    const onVisible = () => {
      if (!document.hidden) void tick(true);
    };
    document.addEventListener('visibilitychange', onVisible);

    const timer = setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [screeningId, refresh]);

  const seatsById = useMemo(() => {
    const index = new Map<number, { seat: SeatView; row: SeatMapRow }>();
    for (const row of seatMap?.rows ?? []) {
      for (const seat of row.seats) index.set(seat.id, { seat, row });
    }
    return index;
  }, [seatMap]);

  const selectedRow = useMemo(() => {
    const first = selected[0];
    return first === undefined ? null : (seatsById.get(first)?.row ?? null);
  }, [selected, seatsById]);

  /**
   * Keep the pending selection legal by construction: one row, always contiguous.
   * Clicking somewhere that cannot extend the current run simply starts a new one,
   * which is less irritating than an error message for something we can just fix.
   */
  const toggleSeat = useCallback(
    (seat: SeatView) => {
      setSelected((current) => {
        if (current.includes(seat.id)) {
          const numbers = current
            .map((id) => seatsById.get(id)?.seat.seatNumber ?? 0)
            .sort((a, b) => a - b);
          const isEndpoint =
            seat.seatNumber === numbers[0] || seat.seatNumber === numbers[numbers.length - 1];
          if (isEndpoint) return current.filter((id) => id !== seat.id);
          // Removing from the middle would split the run - restart from here instead.
          return [seat.id];
        }

        if (current.length === 0) return [seat.id];

        const currentRow = seatsById.get(current[0]!)?.row;
        if (!currentRow || currentRow.label !== seat.rowLabel) return [seat.id];
        if (current.length >= settings.maxSeatsPerReservation) return [seat.id];

        const numbers = current
          .map((id) => seatsById.get(id)?.seat.seatNumber ?? 0)
          .sort((a, b) => a - b);
        const low = numbers[0]!;
        const high = numbers[numbers.length - 1]!;
        const extends_ = seat.seatNumber === low - 1 || seat.seatNumber === high + 1;
        return extends_ ? [...current, seat.id] : [seat.id];
      });
    },
    [seatsById, settings.maxSeatsPerReservation],
  );

  /**
   * The same rule module the API runs, applied to the pending selection. The server
   * still has the final word - this only saves the user a rejected round-trip.
   */
  const preflight = useMemo(() => {
    if (selected.length === 0 || !selectedRow) return null;
    const occupied = selectedRow.seats
      .filter((seat) => seat.status !== 'available')
      .map((seat) => seat.seatNumber);
    const chosen = selected
      .map((id) => seatsById.get(id)?.seat.seatNumber ?? 0)
      .sort((a, b) => a - b);

    return validateSeatSelection({
      rowLength: selectedRow.seatCount,
      occupied,
      selected: chosen,
      maxSeatsPerReservation: settings.maxSeatsPerReservation,
    });
  }, [selected, selectedRow, seatsById, settings.maxSeatsPerReservation]);

  const selectionLabels = useMemo(
    () =>
      selected
        .map((id) => seatsById.get(id)?.seat)
        .filter((seat): seat is SeatView => Boolean(seat))
        .sort((a, b) => a.seatNumber - b.seatNumber)
        .map((seat) => `${seat.rowLabel}${seat.seatNumber}`),
    [selected, seatsById],
  );

  async function handleHold() {
    if (screeningId === null || selected.length === 0) return;
    setBusy(true);
    try {
      const { reservation } = await api.hold(screeningId, selected);
      setSelected([]);
      await refresh(screeningId);
      toast.push({
        tone: 'success',
        message: `Holding ${reservation.seats
          .map((seat) => `${seat.rowLabel}${seat.seatNumber}`)
          .join(', ')} for ${settings.holdMinutes} minutes.`,
      });
    } catch (error) {
      if (error instanceof ApiError) {
        const details = error.details as { diagram?: string } | undefined;
        toast.push({ tone: 'error', message: error.message, diagram: details?.diagram });
        if (error.status === 409) {
          setSelected([]);
          await refresh(screeningId).catch(() => undefined);
        }
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleConfirm(reservationId: string) {
    if (screeningId === null) return;
    setBusy(true);
    try {
      const { reservation } = await api.confirm(reservationId);
      await refresh(screeningId);
      toast.push({
        tone: 'success',
        message: `Booked ${reservation.seats
          .map((seat) => `${seat.rowLabel}${seat.seatNumber}`)
          .join(', ')}. Enjoy the film.`,
      });
    } catch (error) {
      if (error instanceof ApiError) {
        toast.push({ tone: 'error', message: error.message });
        await refresh(screeningId).catch(() => undefined);
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleRelease(reservationId: string) {
    if (screeningId === null) return;
    setBusy(true);
    try {
      await api.release(reservationId);
      await refresh(screeningId);
      toast.push({ tone: 'info', message: 'Seats released.' });
    } catch (error) {
      if (error instanceof ApiError) toast.push({ tone: 'error', message: error.message });
    } finally {
      setBusy(false);
    }
  }

  const handleExpire = useCallback(
    (reservationId: string) => {
      setReservations((current) => current.filter((item) => item.id !== reservationId));
      toast.push({ tone: 'info', message: 'A hold ran out and those seats went back on sale.' });
      if (screeningId !== null) void refresh(screeningId).catch(() => undefined);
    },
    [screeningId, refresh, toast],
  );

  const screening = seatMap?.screening;
  const liveHolds = reservations.filter(
    (item) => item.status === 'booked' || (item.status === 'held' && new Date(item.expiresAt) > new Date()),
  );

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
              Tonight at Hall 1
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
              <SeatMapView
                seatMap={seatMap}
                selected={new Set(selected)}
                onToggleSeat={toggleSeat}
                animate={justSwitched}
              />
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

              {selectionLabels.length > 0 ? (
                <>
                  <p className="eyebrow">
                    {selectionLabels.length} seat{selectionLabels.length > 1 ? 's' : ''} selected
                  </p>
                  <div className="ticket__seats">
                    {selectionLabels.map((label) => (
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

              {preflight && !preflight.ok ? (
                <p className="ticket__notice" role="alert">
                  {preflight.violation.message}
                  {preflight.violation.diagram ? <code>{preflight.violation.diagram}</code> : null}
                </p>
              ) : null}

              <div className="ticket__actions">
                <button
                  type="button"
                  className="btn btn--paper"
                  disabled={busy || selected.length === 0 || (preflight ? !preflight.ok : false)}
                  onClick={handleHold}
                >
                  Hold for {settings.holdMinutes} min
                </button>
                {selected.length > 0 ? (
                  <button
                    type="button"
                    className="btn btn--paper-ghost"
                    onClick={() => setSelected([])}
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
