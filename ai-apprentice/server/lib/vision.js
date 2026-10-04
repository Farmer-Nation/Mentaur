// Vision adapter: turn a screen frame into semantic events ("what changed"),
// not video. Calls the Anthropic Messages API directly with global fetch so the
// project needs no SDK and no npm install. Falls back to a no-op in MOCK mode,
// where the browser's sandbox ERP supplies ground-truth events instead.
//
// Swap PROVIDER to 'openai' or 'gemini' by adding a sibling branch; the return
// shape ([{type, text, invId}]) is all the rest of the app depends on.

const KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.VISION_MODEL || 'claude-sonnet-4-5';

export const visionMode = KEY ? 'anthropic' : 'mock';

const SYSTEM = `You compare two screenshots of a business app and report only what
changed, as JSON. Return {"events":[{"text":"...", "invId":"..."}]}. Each event is
one short factual change, e.g. "INV-4471 cost center changed 4711 -> 0400" or
"INV-4472 opened". Report nothing that did not change. No prose.`;

// framePrev / frameNext are data URLs (base64 PNG/JPEG) from the browser.
export async function analyzeFrames(framePrev, frameNext) {
  if (visionMode === 'mock') return { events: [] };
  const content = [{ type: 'text', text: 'Previous frame, then current frame. What changed?' }];
  for (const f of [framePrev, frameNext]) {
    if (!f) continue;
    const m = /^data:(image\/\w+);base64,(.+)$/.exec(f);
    if (!m) continue;
    content.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
  }
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model: MODEL, max_tokens: 400, system: SYSTEM, messages: [{ role: 'user', content }] }),
    });
    const data = await r.json();
    const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    const json = JSON.parse(text.replace(/```json|```/g, '').trim());
    return { events: Array.isArray(json.events) ? json.events : [] };
  } catch (e) {
    console.warn('[vision] falling back, error:', e.message);
    return { events: [] };
  }
}
