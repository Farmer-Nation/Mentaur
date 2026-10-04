// Lightweight PII redaction for transcripts, events and Work Map text.
// For production, swap redactText() for a call to Microsoft Presidio
// (github.com/microsoft/presidio) — the interface stays the same.

const PATTERNS = [
  { re: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, tag: '[EMAIL]' },
  { re: /\b(?:\+?\d[\d\s().-]{7,}\d)\b/g, tag: '[PHONE]' },
  { re: /€\s?[\d.,]+/g, tag: '€●●●' },
  { re: /\bIBAN[:\s]*[A-Z]{2}\d{2}[A-Z0-9]{10,}\b/gi, tag: '[IBAN]' },
];

// Supplier names from the scenario are domain PII in this demo.
const NAMED = [
  'Baumann Maschinen GmbH',
  'Novák s.r.o. (Czech subsidiary)',
  'Weber Supplies',
  'Hartmann Werkzeug AG',
];

export function redactText(text, enabled) {
  if (!enabled || typeof text !== 'string') return text;
  let out = text;
  for (const n of NAMED) out = out.split(n).join('████████');
  for (const { re, tag } of PATTERNS) out = out.replace(re, tag);
  return out;
}

export function redactDeep(value, enabled) {
  if (!enabled) return value;
  if (typeof value === 'string') return redactText(value, true);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, true));
  if (value && typeof value === 'object') {
    const o = {};
    for (const k of Object.keys(value)) o[k] = redactDeep(value[k], true);
    return o;
  }
  return value;
}
