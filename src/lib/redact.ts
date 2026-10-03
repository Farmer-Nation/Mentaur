// Lightweight PII redaction applied to transcripts and vision-model text
// before persistence. This is a regex-based stand-in for the brief's
// suggested Microsoft Presidio pipeline (see README) — good enough for a
// hackathon demo, not a substitute for a real NER-based redactor in
// production.

const PATTERNS: { label: string; re: RegExp }[] = [
  { label: "EMAIL", re: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g },
  { label: "PHONE", re: /\+?\d[\d\s().-]{7,}\d/g },
  { label: "IBAN", re: /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g },
  { label: "CARD", re: /\b(?:\d[ -]*?){13,16}\b/g },
];

export function redactText(input: string): string {
  let out = input;
  for (const { label, re } of PATTERNS) {
    out = out.replace(re, `[REDACTED_${label}]`);
  }
  return out;
}

export function redactEventSummary(summary: string): string {
  return redactText(summary);
}
