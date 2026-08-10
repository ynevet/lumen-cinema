import type { SeatMap, SeatView } from '@lumen/shared';

interface Props {
  seatMap: SeatMap;
  /** Seat ids in the pending (not yet submitted) selection. */
  selected: ReadonlySet<number>;
  onToggleSeat: (seat: SeatView) => void;
}

function seatClass(seat: SeatView, isSelected: boolean): string {
  if (isSelected) return 'seat seat--selected';
  if (seat.mine) return seat.status === 'booked' ? 'seat seat--mine-booked' : 'seat seat--mine';
  if (seat.status === 'booked') return 'seat seat--booked';
  if (seat.status === 'reserved') return 'seat seat--reserved';
  return 'seat seat--available';
}

function seatLabel(seat: SeatView, isSelected: boolean): string {
  const id = `${seat.rowLabel}${seat.seatNumber}`;
  if (isSelected) return `${id}, in your selection. Click to remove.`;
  if (seat.mine) return `${id}, ${seat.status === 'booked' ? 'booked by you' : 'held by you'}`;
  if (seat.status === 'available') return `${id}, available. Click to select.`;
  return `${id}, ${seat.status}`;
}

export function SeatMapView({ seatMap, selected, onToggleSeat }: Props) {
  return (
    <div className="auditorium">
      <div className="screen">
        <div className="screen__panel" />
        <div className="screen__beam" aria-hidden="true" />
        <p className="screen__label">Screen</p>
      </div>

      <div className="seatmap seatmap--enter">
        {seatMap.rows.map((row) => (
          <div
            key={row.label}
            className="seatrow"
            style={
              {
                '--cols': row.seatCount,
                '--row-index': row.index,
              } as React.CSSProperties
            }
          >
            <span className="seatrow__label" aria-hidden="true">
              {row.label}
            </span>

            {row.seats.map((seat) => {
              const isSelected = selected.has(seat.id);
              const selectable = seat.status === 'available' || isSelected;
              return (
                <button
                  key={seat.id}
                  type="button"
                  className={seatClass(seat, isSelected)}
                  aria-pressed={isSelected}
                  aria-label={seatLabel(seat, isSelected)}
                  disabled={!selectable}
                  onClick={() => onToggleSeat(seat)}
                >
                  <span className="seat__num" aria-hidden="true">
                    {seat.seatNumber}
                  </span>
                </button>
              );
            })}

            <span className="seatrow__label" aria-hidden="true">
              {row.label}
            </span>
          </div>
        ))}
      </div>

      <div className="legend">
        <span className="legend__item">
          <span className="legend__swatch" aria-hidden="true" /> Available
        </span>
        <span className="legend__item">
          <span className="legend__swatch legend__swatch--selected" aria-hidden="true" /> Your
          selection
        </span>
        <span className="legend__item">
          <span className="legend__swatch legend__swatch--mine" aria-hidden="true" /> Held by you
        </span>
        <span className="legend__item">
          <span className="legend__swatch legend__swatch--reserved" aria-hidden="true" /> Reserved
        </span>
        <span className="legend__item">
          <span className="legend__swatch legend__swatch--booked" aria-hidden="true" /> Booked
        </span>
      </div>

      <p className="tally">
        <span>{seatMap.totals.available} available</span>
        <span>{seatMap.totals.reserved} reserved</span>
        <span>{seatMap.totals.booked} booked</span>
      </p>
    </div>
  );
}
