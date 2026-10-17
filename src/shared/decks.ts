export type Card = { label: string; value: number | null };

export type Deck = {
  id: string;
  name: string;
  /** Labels are numbers (show average/median); false for decks like T-shirt. */
  numeric: boolean;
  cards: Card[];
};

export const UNSURE = '?';
export const COFFEE = '☕';

const nums = (values: number[]): Card[] => values.map((v) => ({ label: String(v), value: v }));
const special = (...labels: string[]): Card[] => labels.map((label) => ({ label, value: null }));

export const PRESET_DECKS: Deck[] = [
  {
    id: 'fibonacci',
    name: 'Fibonacci',
    numeric: true,
    cards: [...nums([0, 1, 2, 3, 5, 8, 13, 21]), ...special(UNSURE, COFFEE)],
  },
  {
    id: 'modified-fibonacci',
    name: 'Fibonacci modificado',
    numeric: true,
    cards: [
      { label: '0', value: 0 },
      { label: '½', value: 0.5 },
      ...nums([1, 2, 3, 5, 8, 13, 20, 40, 100]),
      ...special(UNSURE, COFFEE),
    ],
  },
  {
    id: 't-shirt',
    name: 'T-shirt',
    numeric: false,
    cards: [
      { label: 'XS', value: 1 },
      { label: 'S', value: 2 },
      { label: 'M', value: 3 },
      { label: 'L', value: 5 },
      { label: 'XL', value: 8 },
      { label: 'XXL', value: 13 },
      ...special(UNSURE),
    ],
  },
  {
    id: 'powers-of-2',
    name: 'Potências de 2',
    numeric: true,
    cards: [...nums([0, 1, 2, 4, 8, 16, 32, 64]), ...special(UNSURE)],
  },
];

export const MAX_CUSTOM_CARDS = 20;
export const MAX_CARD_LABEL = 8;

function parseCardValue(label: string): number | null {
  if (label === '½') return 0.5;
  const n = Number(label.replace(',', '.'));
  return label !== '' && Number.isFinite(n) ? n : null;
}

/** Builds a custom deck from a comma-separated list such as "1, 2, 3, ?". */
export function parseCustomDeck(input: string): Deck {
  const labels = [...new Set(input.split(',').map((s) => s.trim()).filter(Boolean))];
  if (labels.length < 2) throw new Error('O deck precisa de pelo menos 2 cards');
  if (labels.length > MAX_CUSTOM_CARDS) throw new Error(`O deck aceita no máximo ${MAX_CUSTOM_CARDS} cards`);
  const tooLong = labels.find((l) => l.length > MAX_CARD_LABEL);
  if (tooLong) throw new Error(`Card "${tooLong}" passa de ${MAX_CARD_LABEL} caracteres`);
  const cards = labels.map((label) => ({ label, value: parseCardValue(label) }));
  const regular = cards.filter((c) => c.label !== UNSURE && c.label !== COFFEE);
  return {
    id: 'custom',
    name: 'Personalizado',
    numeric: regular.length > 0 && regular.every((c) => c.value !== null),
    cards,
  };
}

export function resolveDeck(deckId: string, customCards?: string): Deck {
  if (deckId === 'custom') return parseCustomDeck(customCards ?? '');
  const deck = PRESET_DECKS.find((d) => d.id === deckId);
  if (!deck) throw new Error('Deck inválido');
  return deck;
}
