/**
 * Physical layout of the cinema hall, as specified by the specification:
 *   - 10 rows of 10 seats  (A .. J)
 *   -  3 rows of  5 seats  (K .. M)
 *
 * The layout lives in shared code because it is needed in three places:
 *   1. the seeder, which materialises one `seats` row per physical seat,
 *   2. the API, which validates that a selection fits inside its row,
 *   3. the web client, which renders the grid.
 */

export interface RowBlueprint {
  /** Human facing label, e.g. "A". Unique within an auditorium. */
  readonly label: string;
  /** 1-based position from the screen backwards. Used for stable ordering. */
  readonly index: number;
  /** Number of seats in this row. */
  readonly seatCount: number;
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function buildRows(blocks: ReadonlyArray<{ rows: number; seats: number }>): RowBlueprint[] {
  const rows: RowBlueprint[] = [];
  for (const block of blocks) {
    for (let i = 0; i < block.rows; i += 1) {
      const index = rows.length + 1;
      const label = ALPHABET[index - 1];
      if (label === undefined) {
        throw new Error(`Layout exceeds ${ALPHABET.length} rows; extend the label scheme.`);
      }
      rows.push({ label, index, seatCount: block.seats });
    }
  }
  return rows;
}

export const DEFAULT_LAYOUT: ReadonlyArray<RowBlueprint> = Object.freeze(
  buildRows([
    { rows: 10, seats: 10 },
    { rows: 3, seats: 5 },
  ]),
);

export const TOTAL_SEATS = DEFAULT_LAYOUT.reduce((sum, row) => sum + row.seatCount, 0);

/** Widest row in the layout - used by the client to centre narrower rows. */
export const MAX_ROW_WIDTH = DEFAULT_LAYOUT.reduce((max, row) => Math.max(max, row.seatCount), 0);
