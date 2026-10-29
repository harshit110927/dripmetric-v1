/**
 * Money in minor units and a currency code, never a float (CLAUDE.md invariants).
 *
 * `(minor / 100).toFixed(2)` is the one division allowed, and only at the edge where
 * a number becomes text. Nothing upstream of here holds a price as a float, so a
 * rounding error has nowhere to accumulate.
 *
 * Deliberately NOT `Intl.NumberFormat`, which would render 2499 USD as "US$24.99" or
 * "$24.99" depending on the locale the server happens to run in. The payback line in
 * the weekly report has to read exactly as the brief writes it, so the format is
 * ours and does not move with the environment.
 */
export function formatMoney(minorUnits: number, currency: string): string {
  const symbol = SYMBOLS[currency.toLowerCase()];
  const major = (minorUnits / 100).toFixed(2);
  return symbol === undefined ? `${major} ${currency.toUpperCase()}` : `${symbol}${major}`;
}

/**
 * Only the few we can write without guessing. Anything else is shown as
 * "1234.00 SEK", which is unambiguous even if it is not pretty — and a wrong symbol
 * on a revenue figure is worse than no symbol.
 */
const SYMBOLS: Record<string, string> = {
  usd: '$',
  eur: '€',
  gbp: '£',
};

/** "12 users" / "1 user". Said out loud often enough to be worth one function. */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`;
}
