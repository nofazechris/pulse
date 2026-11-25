/**
 * Text helpers for the G2 font: ASCII only (unsupported glyphs are silently dropped by the firmware),
 * no alignment control (we pad with spaces), proportional glyph widths (so budgets are conservative).
 */
const MAP: Record<string, string> = {
  '‘': "'", '’': "'", '“': '"', '”': '"', '–': '-', '—': '-', '…': '...',
  '↑': '^', '↓': 'v', '→': '>', '·': '.', '•': '*', ' ': ' ',
};

export function ascii(s: string): string {
  let out = '';
  for (const ch of s) {
    if (ch === '\n') out += ch;
    else if (ch >= ' ' && ch <= '~') out += ch;
    else out += MAP[ch] ?? '?';
  }
  return out;
}

export function clip(s: string, max: number): string {
  const a = ascii(s);
  return a.length <= max ? a : `${a.slice(0, Math.max(0, max - 2))}..`;
}

/** Word-wraps to `width` columns. Never returns an empty array. */
export function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const para of ascii(text).split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (word.length > width) {
        if (line) { lines.push(line); line = ''; }
        for (let i = 0; i < word.length; i += width) lines.push(word.slice(i, i + width));
        continue;
      }
      if (!line) line = word;
      else if (line.length + 1 + word.length <= width) line += ` ${word}`;
      else { lines.push(line); line = word; }
    }
    lines.push(line);
  }
  return lines.length ? lines : [''];
}

export function twoCol(left: string, right: string, width: number): string {
  const l = ascii(left);
  const r = ascii(right);
  return `${l}${' '.repeat(Math.max(1, width - l.length - r.length))}${r}`.slice(0, width + 8);
}

export const LINE = 44; // conservative characters per body line (proportional font, ~66 fit)
export const BODY_LINES = 6;
