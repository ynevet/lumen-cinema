import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_SEATS_PER_RESERVATION,
  findTrappedSingles,
  renderRowDiagram,
  validateSeatSelection,
} from './seatRules.js';
import { DEFAULT_LAYOUT, MAX_ROW_WIDTH, TOTAL_SEATS } from './layout.js';

const ROW = 10;

function check(occupied: number[], selected: number[], rowLength = ROW) {
  return validateSeatSelection({ rowLength, occupied, selected });
}

function codeOf(result: ReturnType<typeof check>): string | null {
  return result.ok ? null : result.violation.code;
}

describe('layout', () => {
  it('matches the specification: 10 rows of 10 plus 3 rows of 5', () => {
    expect(DEFAULT_LAYOUT).toHaveLength(13);
    expect(DEFAULT_LAYOUT.filter((r) => r.seatCount === 10)).toHaveLength(10);
    expect(DEFAULT_LAYOUT.filter((r) => r.seatCount === 5)).toHaveLength(3);
    expect(DEFAULT_LAYOUT.map((r) => r.label).join('')).toBe('ABCDEFGHIJKLM');
    expect(TOTAL_SEATS).toBe(115);
    expect(MAX_ROW_WIDTH).toBe(10);
  });

  it('numbers rows from 1 with no gaps', () => {
    expect(DEFAULT_LAYOUT.map((r) => r.index)).toEqual([...Array(13)].map((_, i) => i + 1));
  });
});

describe('rule 1 - consecutive seats in one row', () => {
  it('accepts a run of consecutive seats', () => {
    expect(check([], [5, 6, 7]).ok).toBe(true);
    expect(check([], [1, 2]).ok).toBe(true);
    expect(check([], [7]).ok).toBe(true);
  });

  it('accepts seats given out of order', () => {
    expect(check([], [7, 5, 6]).ok).toBe(true);
  });

  it('rejects a gapped selection', () => {
    expect(codeOf(check([], [5, 7]))).toBe('NOT_CONSECUTIVE');
    expect(codeOf(check([], [2, 3, 5]))).toBe('NOT_CONSECUTIVE');
  });

  it('rejects an empty selection', () => {
    expect(codeOf(check([], []))).toBe('EMPTY_SELECTION');
  });

  it('rejects duplicates', () => {
    expect(codeOf(check([], [4, 4]))).toBe('DUPLICATE_SEATS');
  });

  it('rejects seats outside the row', () => {
    expect(codeOf(check([], [10, 11]))).toBe('SEAT_OUT_OF_RANGE');
    expect(codeOf(check([], [0, 1]))).toBe('SEAT_OUT_OF_RANGE');
    expect(codeOf(check([], [5, 6], 5))).toBe('SEAT_OUT_OF_RANGE');
  });

  it('rejects more seats than the per-reservation cap', () => {
    const tooMany = [...Array(DEFAULT_MAX_SEATS_PER_RESERVATION + 1)].map((_, i) => i + 1);
    expect(codeOf(check([], tooMany))).toBe('TOO_MANY_SEATS');
  });

  it('rejects seats already taken', () => {
    expect(codeOf(check([5], [4, 5]))).toBe('SEAT_UNAVAILABLE');
  });
});

describe('rule 2 - no isolated empty seat between occupied seats', () => {
  // The three worked examples from the specification.
  it('brief example 1: seats 1-2 booked, selecting 3-4 is valid', () => {
    const result = check([1, 2], [3, 4]);
    expect(result.ok).toBe(true);
    expect(renderRowDiagram(ROW, [1, 2], [3, 4])).toBe('# # * * . . . . . .');
  });

  it('brief example 2: seats 1-2 booked, selecting 4-5 strands seat 3', () => {
    const result = check([1, 2], [4, 5]);
    expect(codeOf(result)).toBe('ISOLATED_SEAT');
    if (!result.ok) {
      expect(result.violation.seatNumbers).toEqual([3]);
      expect(result.violation.diagram).toBe('# # . * * . . . . .');
    }
  });

  it('brief example 3: empty row, selecting 2-10 leaves seat 1 at the edge (allowed)', () => {
    expect(check([], [2, 3, 4, 5, 6, 7, 8, 9, 10], ROW).ok).toBe(true);
  });

  it('allows a single empty seat at the far edge', () => {
    // . . . . . . . . * *  -> nothing trapped
    expect(check([], [9, 10]).ok).toBe(true);
    // # . * * ... -> seat 2 is trapped between 1 and 3
    expect(codeOf(check([1], [3, 4]))).toBe('ISOLATED_SEAT');
    // seat 10 left alone next to the wall is fine
    expect(check([], [7, 8, 9]).ok).toBe(true);
  });

  it('allows filling the gap entirely', () => {
    expect(check([1, 2], [3]).ok).toBe(true);
    expect(check([1, 4], [2, 3]).ok).toBe(true);
  });

  it('allows a remaining gap of two or more', () => {
    // # # . . * * -> gap of 2 between seat 2 and seat 5
    expect(check([1, 2], [5, 6]).ok).toBe(true);
  });

  it('detects a trap created on the left of the selection', () => {
    expect(codeOf(check([8], [5, 6]))).toBe('ISOLATED_SEAT'); // seat 7 stranded
  });

  it('detects two traps created at once', () => {
    const result = check([1, 8], [3, 4, 5, 6]);
    expect(codeOf(result)).toBe('ISOLATED_SEAT');
    if (!result.ok) expect(result.violation.seatNumbers).toEqual([2, 7]);
  });

  it('does not blame a selection for a trap that already existed', () => {
    // Seat 2 is already stranded between booked seats 1 and 3 before anyone clicks.
    // Selecting 6-7 at the other end of the row must still be allowed, otherwise the
    // whole row becomes unsellable.
    expect(check([1, 3], [6, 7]).ok).toBe(true);
  });

  it('still rejects a new trap in a row that already has one', () => {
    // Pre-existing trap at seat 2; selecting 5-6 additionally strands seat 4.
    const result = check([1, 3], [5, 6]);
    expect(codeOf(result)).toBe('ISOLATED_SEAT');
    if (!result.ok) expect(result.violation.seatNumbers).toEqual([4]);
  });

  it('handles the 5-seat rows', () => {
    expect(check([1, 2], [3, 4], 5).ok).toBe(true);
    expect(codeOf(check([1, 2], [4, 5], 5))).toBe('ISOLATED_SEAT');
    expect(check([], [2, 3, 4, 5], 5).ok).toBe(true);
  });
});

describe('findTrappedSingles', () => {
  it('ignores the row edges', () => {
    expect(findTrappedSingles(new Set([2]), ROW)).toEqual([]);
    expect(findTrappedSingles(new Set([9]), ROW)).toEqual([]);
  });

  it('finds interior single gaps only', () => {
    expect(findTrappedSingles(new Set([1, 3]), ROW)).toEqual([2]);
    expect(findTrappedSingles(new Set([1, 4]), ROW)).toEqual([]); // gap of 2 is fine
    expect(findTrappedSingles(new Set([1, 3, 5]), ROW)).toEqual([2, 4]);
  });
});

describe('renderRowDiagram', () => {
  it('renders occupied, selected and empty seats', () => {
    expect(renderRowDiagram(5, [1], [3, 4])).toBe('# . * * .');
  });
});
