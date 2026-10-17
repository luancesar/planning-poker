import type { Deck } from './decks';

export type Consensus = 'full' | 'near' | 'low' | 'none';

export type RoundStats = {
  total: number;
  /** Votes with a numeric value; ? and ☕ are excluded. */
  counted: number;
  average: number | null;
  median: number | null;
  modes: string[];
  distribution: { label: string; count: number }[];
  consensus: Consensus;
  /** Card the facilitator will most likely pick as the final estimate. */
  suggestion: string | null;
};

const round1 = (n: number) => Math.round(n * 10) / 10;

export function computeStats(deck: Deck, votes: { cardLabel: string }[]): RoundStats {
  const counts = new Map<string, number>();
  for (const v of votes) counts.set(v.cardLabel, (counts.get(v.cardLabel) ?? 0) + 1);

  const distribution = deck.cards
    .filter((c) => counts.has(c.label))
    .map((c) => ({ label: c.label, count: counts.get(c.label)! }));

  const valued = deck.cards.filter((c) => c.value !== null);
  const counted = valued.filter((c) => counts.has(c.label));
  const values = counted.flatMap((c) => Array<number>(counts.get(c.label)!).fill(c.value!)).sort((a, b) => a - b);

  if (values.length === 0) {
    return { total: votes.length, counted: 0, average: null, median: null, modes: [], distribution, consensus: 'none', suggestion: null };
  }

  const average = values.reduce((a, b) => a + b, 0) / values.length;
  const mid = Math.floor(values.length / 2);
  const median = values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;

  const max = Math.max(...counted.map((c) => counts.get(c.label)!));
  const modes = counted.filter((c) => counts.get(c.label) === max).map((c) => c.label);

  const indexes = counted.map((c) => valued.indexOf(c));
  const spread = Math.max(...indexes) - Math.min(...indexes);
  const consensus: Consensus = spread === 0 ? 'full' : spread === 1 ? 'near' : 'low';

  let suggestion = modes.length === 1 ? modes[0] : null;
  if (!suggestion) {
    // Nearest card to the median; ties go to the larger card (estimates tend to be optimistic).
    let best = valued[0];
    for (const c of valued) {
      if (Math.abs(c.value! - median) <= Math.abs(best.value! - median)) best = c;
    }
    suggestion = best.label;
  }

  return {
    total: votes.length,
    counted: values.length,
    average: round1(average),
    median: round1(median),
    modes,
    distribution,
    consensus,
    suggestion,
  };
}
