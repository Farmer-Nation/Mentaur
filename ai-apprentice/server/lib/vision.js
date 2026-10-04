// Claude vision adapter for arbitrary shared screens.
//
// Cost-control strategy:
//   - the browser does cheap local pixel-change detection every ~1.5s;
//   - Claude is called only for a changed frame after a throttle window;
//   - each request sends ONE compressed current frame plus a tiny text summary
//     of the prior state, rather than two full screenshots.
//
// One Claude call returns the screen observation, a chat-ready live activity summary,
// semantic events, the single best Guide question, and Student question suggestions.
// That avoids extra vision calls for the same frame.

const KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.VISION_MODEL || 'claude-haiku-4-5';

export const visionMode = KEY ? 'claude' : 'mock';

const SYSTEM = `You are the vision layer for an AI apprentice watching an expert's shared screen.
The shared content can be ANY desktop application, browser tab, document, spreadsheet, terminal,
ERP, CRM, design tool, or other knowledge-work screen. Analyze only what is visibly supported.

Your goal is not to narrate every pixel. Identify meaningful workflow changes, decisions, exceptions,
manual overrides, warnings, submissions, approvals, edits, navigation, or other actions that a new hire
would need to understand. Never invent hidden state. Do not repeat passwords, access tokens, full email
addresses, or other obvious secrets even if visible; describe them generically.

Return ONLY compact JSON with this shape:
{
  "screen": {"app":"short app/type", "state":"one short sentence", "focus":"what the expert appears to be working on"},
  "activity_summary": "one concise present-tense sentence suitable for a live chat activity log",
  "events": [{"text":"one factual visible change/current action", "kind":"navigation|edit|decision|submission|warning|other", "importance":"low|medium|high", "invId":"optional visible invoice id"}],
  "question": {"q":"one spoken question, max 20 words", "guardrail":true|false, "key":"short stable key"},
  "student_questions": ["question 1", "question 2", "question 3"]
}

Question rules:
- Always provide one grounded, useful question while a recognizable task or page is visible, regardless of app or browser tab.
- Prefer a reason, judgment call, exception, limit, approval rule, risky action, or a useful guardrail question when supported.
- Otherwise ask a lightweight intent/process question about what the expert is visibly doing or looking for.
- The question MUST be grounded in something visible now and must not ask for a fact the screen already answers.
- Prefer WHY / WHAT WOULD CHANGE THIS / WHAT ARE YOU LOOKING FOR / WHEN WOULD YOU STOP questions.
- When useful, surface a clear "when to stop" or ask-for-help condition supported by the screen.
- Keep activity_summary factual and non-sensitive. Keep events to 0-3 and student_questions to 0-3. Be concise to minimize tokens.`;

function parseJSON(text) {
  if (!text) return null;
  const cleaned = text.replace(/```json|```/g, '').trim();
  try { return JSON.parse(cleaned); } catch {}
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(cleaned.slice(start, end + 1)); } catch {}
  }
  return null;
}

function normalize(out) {
  const screen = out && typeof out.screen === 'object' ? out.screen : {};
  const events = Array.isArray(out?.events) ? out.events.slice(0, 3)
    .filter((e) => e && typeof e.text === 'string' && e.text.trim())
    .map((e) => ({
      text: e.text.trim().slice(0, 240),
      kind: String(e.kind || 'other').slice(0, 24),
      importance: ['low', 'medium', 'high'].includes(e.importance) ? e.importance : 'medium',
      ...(e.invId ? { invId: String(e.invId).slice(0, 64) } : {}),
    })) : [];
  const q = out?.question && typeof out.question.q === 'string' && out.question.q.trim()
    ? {
        q: out.question.q.trim().slice(0, 220),
        guardrail: !!out.question.guardrail,
        key: String(out.question.key || '').trim().slice(0, 100),
      }
    : null;
  const studentQuestions = Array.isArray(out?.student_questions)
    ? out.student_questions.filter((x) => typeof x === 'string' && x.trim()).slice(0, 3).map((x) => x.trim().slice(0, 160))
    : [];
  const summary = [screen.app, screen.state, screen.focus].filter(Boolean).join(' | ').slice(0, 700);
  const activitySummary = typeof out?.activity_summary === 'string' && out.activity_summary.trim()
    ? out.activity_summary.trim().slice(0, 260)
    : [screen.state, screen.focus].filter(Boolean).join(' — ').slice(0, 260);
  return { screen, summary, activitySummary, events, question: q, studentQuestions };
}

// frame is a data URL (compressed JPEG/PNG) from the browser.
// priorSummary is text only, so recurring calls pay for one image rather than two.
export async function analyzeFrame(frame, priorSummary = '') {
  if (visionMode === 'mock' || !frame) return { screen: {}, summary: priorSummary || '', activitySummary: '', events: [], question: null, studentQuestions: [] };
  const m = /^data:(image\/[\w.+-]+);base64,(.+)$/.exec(frame);
  if (!m) return { screen: {}, summary: priorSummary || '', activitySummary: '', events: [], question: null, studentQuestions: [] };

  const content = [
    {
      type: 'text',
      text: priorSummary
        ? `Prior compact screen state: ${priorSummary}\nAnalyze the current frame. Report only meaningful new/current workflow information.`
        : 'This is the first observed frame. Identify the visible work context and any decision/guardrail worth asking about.',
    },
    { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } },
  ];

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 460,
        system: SYSTEM,
        messages: [{ role: 'user', content }],
      }),
    });
    if (!r.ok) throw new Error(`Claude vision ${r.status}: ${(await r.text()).slice(0, 180)}`);
    const data = await r.json();
    const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    const parsed = parseJSON(text);
    if (!parsed) throw new Error('Claude returned non-JSON vision output');
    return normalize(parsed);
  } catch (e) {
    console.warn('[vision] analysis skipped:', e.message);
    return { screen: {}, summary: priorSummary || '', activitySummary: '', events: [], question: null, studentQuestions: [], error: e.message };
  }
}
