// Personal-data masking: before anything goes to the AI, emails, phone numbers, payment cards, US SSNs, IBANs and
// fields an admin marks as sensitive are swapped for placeholders like [EMAIL_1]. The mapping lives with the run
// (it survives an approval pause), so the AI's answer can refer to [EMAIL_1] and a Salesforce write gets the real
// value back. Steps that send data outside Salesforce (Slack, web calls) keep the placeholders.

export type Kind = 'EMAIL' | 'PHONE' | 'CARD' | 'SSN' | 'IBAN' | 'FIELD';

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const SSN = /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g;
const IBAN = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/g;
const CARD = /\b(?:\d[ -]?){12,18}\d\b/g;
// International or local numbers with at least 9 digits and phone-like separators; plain long ids are left alone.
const PHONE = /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{1,4}\)[\s.-]?)?\d{2,5}[\s.-]\d{2,5}(?:[\s.-]?\d{2,5})?\b|\+\d{9,14}\b/g;

export function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return digits.length >= 13 && sum % 10 === 0;
}

export function ibanValid(raw: string): boolean {
  const s = raw.replace(/\s/g, '');
  if (s.length < 15 || s.length > 34) return false;
  const moved = (s.slice(4) + s.slice(0, 4)).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let rem = 0;
  for (const ch of moved) rem = (rem * 10 + Number(ch)) % 97;
  return rem === 1;
}

const PLACEHOLDER = /\[(EMAIL|PHONE|CARD|SSN|IBAN|FIELD)_(\d+)\]/g;

export class Masker {
  /** token -> real value; stored on the run so it survives pauses. */
  constructor(private map: Record<string, string> = {}, private fields: string[] = []) {}

  get mapping() { return this.map; }

  private tokenFor(kind: Kind, value: string): string {
    for (const [t, v] of Object.entries(this.map)) if (v === value && t.startsWith(`[${kind}_`)) return t;
    const n = Object.keys(this.map).filter((t) => t.startsWith(`[${kind}_`)).length + 1;
    const t = `[${kind}_${n}]`;
    this.map[t] = value;
    return t;
  }

  /** Mask free text. Order matters: emails first (they contain digits), then the checked number formats. */
  maskText(text: string): string {
    if (!text) return text;
    let s = text;
    // "Field: value" lines for sensitive fields (how record data is laid out in prompts).
    if (this.fields.length) {
      const names = this.fields.map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
      s = s.replace(new RegExp(`(^|\\n|"|\\b)(${names})("?\\s*[:=]\\s*"?)([^"\\n,}]+)`, 'g'), (_m, a, f, sep, v) => `${a}${f}${sep}${this.tokenFor('FIELD', v.trim())}`);
    }
    s = s.replace(EMAIL, (m) => this.tokenFor('EMAIL', m));
    s = s.replace(IBAN, (m) => (ibanValid(m) ? this.tokenFor('IBAN', m) : m));
    s = s.replace(SSN, (m) => this.tokenFor('SSN', m));
    s = s.replace(CARD, (m) => (luhn(m.replace(/\D/g, '')) ? this.tokenFor('CARD', m) : m));
    s = s.replace(PHONE, (m) => (m.replace(/\D/g, '').length >= 9 && !/^\[/.test(m) ? this.tokenFor('PHONE', m) : m));
    return s;
  }

  /** Mask a structured value (tool results, records): sensitive fields by key, everything else by pattern. */
  maskValue(v: unknown, key?: string): unknown {
    if (typeof v === 'string') return key && this.fields.some((f) => f.toLowerCase() === key.toLowerCase()) ? this.tokenFor('FIELD', v) : this.maskText(v);
    if (Array.isArray(v)) return v.map((x) => this.maskValue(x));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, this.maskValue(x, k)]));
    return v;
  }

  /** Put real values back (only where the data stays in Salesforce). */
  unmaskText(text: string): string {
    return text.replace(PLACEHOLDER, (m) => this.map[m] ?? m);
  }

  unmaskValue<T>(v: T): T {
    if (typeof v === 'string') return this.unmaskText(v) as T;
    if (Array.isArray(v)) return v.map((x) => this.unmaskValue(x)) as T;
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, this.unmaskValue(x)])) as T;
    return v;
  }

  count(): number { return Object.keys(this.map).length; }
}
