import { dec } from './decimal';

/** "59980.5" -> "59,980.50". Pure string work: no floats. */
export function money(value: string, dp = 2): string {
  const fixed = dec.fmtFixed(dec.parse(value), dp);
  const [int, frac] = fixed.split('.');
  const neg = int!.startsWith('-');
  const digits = neg ? int!.slice(1) : int!;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}${grouped}${frac !== undefined ? '.' + frac : ''}`;
}

/** Quantity with trailing zeros trimmed, grouped integer part. */
export function qty(value: string): string {
  const [int, frac] = dec.fmt(dec.parse(value)).split('.');
  return `${int!.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${frac ? '.' + frac : ''}`;
}

export function pct(value: string): string {
  const s = dec.fmtFixed(dec.parse(value), 2);
  return `${s.startsWith('-') ? '' : '+'}${s}%`;
}

/** Price shown with sensible precision: 2dp above 1, up to 6dp below. */
export function price(value: string): string {
  return dec.gte(dec.parse(value), dec.parse('1')) ? money(value, 2) : money(value, 6);
}
