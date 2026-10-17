import { describe, expect, it } from 'vitest';
import { parseCustomDeck, PRESET_DECKS } from '@/shared/decks';
import { computeStats } from '@/shared/stats';

const fib = PRESET_DECKS.find((d) => d.id === 'fibonacci')!;
const shirt = PRESET_DECKS.find((d) => d.id === 't-shirt')!;
const v = (...labels: string[]) => labels.map((cardLabel) => ({ cardLabel }));

describe('computeStats', () => {
  it('ignores ? and coffee in numeric stats', () => {
    const s = computeStats(fib, v('3', '5', '5', '?', '☕'));
    expect(s.total).toBe(5);
    expect(s.counted).toBe(3);
    expect(s.average).toBe(4.3);
    expect(s.median).toBe(5);
    expect(s.modes).toEqual(['5']);
    expect(s.suggestion).toBe('5');
    expect(s.consensus).toBe('near');
    expect(s.distribution).toEqual([
      { label: '3', count: 1 },
      { label: '5', count: 2 },
      { label: '?', count: 1 },
      { label: '☕', count: 1 },
    ]);
  });

  it('detects full and low consensus', () => {
    expect(computeStats(fib, v('8', '8')).consensus).toBe('full');
    expect(computeStats(fib, v('1', '13')).consensus).toBe('low');
  });

  it('suggests the card nearest to the median on a tie, preferring the larger card', () => {
    const s = computeStats(fib, v('3', '8'));
    expect(s.modes).toEqual(['3', '8']);
    expect(s.median).toBe(5.5);
    expect(s.suggestion).toBe('5');
    expect(computeStats(fib, v('2', '3')).suggestion).toBe('3');
  });

  it('handles rounds with no numeric votes', () => {
    const s = computeStats(fib, v('?'));
    expect(s.consensus).toBe('none');
    expect(s.average).toBeNull();
    expect(s.suggestion).toBeNull();
  });

  it('works for t-shirt sizes', () => {
    expect(computeStats(shirt, v('M', 'L', 'L')).suggestion).toBe('L');
  });
});

describe('parseCustomDeck', () => {
  it('parses numeric and special cards', () => {
    const d = parseCustomDeck('1, 2, 3, ?, 1');
    expect(d.cards.map((c) => c.label)).toEqual(['1', '2', '3', '?']);
    expect(d.numeric).toBe(true);
  });
  it('rejects bad decks', () => {
    expect(() => parseCustomDeck('1')).toThrow();
    expect(() => parseCustomDeck('muito-longo-demais, 2')).toThrow();
  });
});
