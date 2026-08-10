import { useEffect, useState } from 'react';
import type { Reservation } from '@lumen/shared';

interface Props {
  reservation: Reservation;
  holdMinutes: number;
  onConfirm: (reservationId: string) => void;
  onRelease: (reservationId: string) => void;
  busy: boolean;
  /** Called once when a hold's countdown hits zero, so the parent can refresh. */
  onExpire: (reservationId: string) => void;
}

const URGENT_SECONDS = 60;

function format(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function HoldCard({
  reservation,
  holdMinutes,
  onConfirm,
  onRelease,
  busy,
  onExpire,
}: Props) {
  const isBooked = reservation.status === 'booked';

  // The only state is the current time; everything shown is derived from it. A changed
  // `expiresAt` is therefore reflected on the next tick with no resynchronising effect.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (isBooked) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [isBooked]);

  const remaining = Math.max(
    0,
    Math.round((new Date(reservation.expiresAt).getTime() - now) / 1000),
  );

  // `remaining` only reaches 0 once, so this fires a single time per hold.
  useEffect(() => {
    if (!isBooked && remaining === 0) onExpire(reservation.id);
  }, [isBooked, remaining, reservation.id, onExpire]);

  const seats = reservation.seats.map((seat) => `${seat.rowLabel}${seat.seatNumber}`);
  const urgent = !isBooked && remaining <= URGENT_SECONDS;
  const progress = isBooked ? 100 : Math.min(100, (remaining / (holdMinutes * 60)) * 100);

  return (
    <div className={`stub hold${isBooked ? ' hold--booked' : ''}`}>
      <div className="hold__head">
        <span className="hold__title">{isBooked ? 'Booked' : 'Holding'}</span>
        {isBooked ? (
          <span className="badge">Confirmed</span>
        ) : (
          <span
            className={`clock${urgent ? ' clock--urgent' : ''}`}
            aria-label={`${format(remaining)} left on this hold`}
          >
            {format(remaining)}
          </span>
        )}
      </div>

      <div className="ticket__seats">
        {seats.map((seat) => (
          <span key={seat} className={`seat-chip${isBooked ? ' seat-chip--muted' : ''}`}>
            {seat}
          </span>
        ))}
      </div>

      {isBooked ? null : (
        <>
          <div className="hold__bar">
            <div
              className={`hold__bar-fill${urgent ? ' hold__bar-fill--urgent' : ''}`}
              style={{ width: `${progress}%` }}
            />
          </div>
          <div className="ticket__actions">
            <button
              type="button"
              className="btn btn--paper"
              disabled={busy || remaining === 0}
              onClick={() => onConfirm(reservation.id)}
            >
              Confirm booking
            </button>
            <button
              type="button"
              className="btn btn--paper-ghost"
              disabled={busy}
              onClick={() => onRelease(reservation.id)}
            >
              Release
            </button>
          </div>
        </>
      )}
    </div>
  );
}
