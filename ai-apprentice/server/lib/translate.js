// Text translation adapter.
//
// ElevenLabs does not expose a plain text-translation endpoint — its API only
// translates through the Dubbing resource, which requires an uploaded audio or
// video file (POST /v1/dubbing accepts `file`/`source_url`, not raw text).
// ElevenLabs IS used for the voice half of the language feature: its
// multilingual TTS models (see lib/voice.js) speak Japanese/Vietnamese text
// correctly once it exists. The text translation step below uses Claude —
// already this app's reasoning provider — with a passthrough fallback so the
// app keeps running keyless.

const KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.REASONING_MODEL || 'claude-haiku-4-5';
export const translateMode = KEY ? 'claude' : 'mock';

const LANG_NAMES = { en: 'English', ja: 'Japanese', vi: 'Vietnamese' };
export const SUPPORTED_LANGS = Object.keys(LANG_NAMES);

async function claudeTranslate(text, targetLangName) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 400,
      system: `Translate the user's message into ${targetLangName}. Preserve meaning, tone, numbers, and proper nouns exactly. Reply with only the translated text — no quotes, labels, or commentary.`,
      messages: [{ role: 'user', content: text }],
    }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`Claude translation failed (${r.status}): ${data.error?.message || 'provider rejected the request'}`);
  return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
}

// Translates `text` into the language named by `targetLang` ('en' | 'ja' | 'vi').
// Falls back to the original text — untranslated — when no Anthropic key is
// configured or the call fails, so the room keeps working without an outage.
export async function translateTo(text, targetLang) {
  const clean = String(text || '').trim();
  const name = LANG_NAMES[targetLang];
  if (!clean || !name) return clean;
  if (translateMode === 'mock') return clean;
  try {
    const out = await claudeTranslate(clean, name);
    return out || clean;
  } catch (e) {
    console.warn('[translate] unavailable, passing text through untranslated:', e.message);
    return clean;
  }
}
