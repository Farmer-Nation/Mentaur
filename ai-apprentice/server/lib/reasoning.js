// Reasoning layer. Deterministic triggers (planner) decide WHEN there is
// something worth asking; this module decides HOW to phrase it well and also
// generates (a) suggested questions for the student, who may not know what to
// ask, and (b) the post-session curriculum. Uses Claude when a key is present,
// with deterministic mock fallbacks so everything runs keyless.

import * as planner from './planner.js';
import { buildWorkMap } from './workmap.js';
import { teachInvoice } from './scenario.js';

const KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.REASONING_MODEL || 'claude-haiku-4-5';
export const reasoningMode = KEY ? 'claude' : 'mock';

async function claude(system, user, maxTokens = 500) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
  });
  const data = await r.json();
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  return text;
}
function parseJSON(text, fallback) {
  try { return JSON.parse(text.replace(/```json|```/g, '').trim()); } catch { return fallback; }
}

function recentContext(room) {
  const lastEvents = room.events.slice(-8).map((e) => e.text);
  const answered = room.qa.map((x) => `Q:${x.q} A:${x.a}`);
  const screenSummary = String(room.screenSummary || '').trim();
  return { lastEvents, answered, screenSummary };
}

// The single best question to ask the GUIDE right now about a visible change,
// or null. `cand` is the deterministic trigger from the planner.
export async function phraseGuideQuestion(room, cand) {
  if (!cand) return null;
  // Claude vision already phrased arbitrary-screen questions in the same paid call.
  if (cand.source === 'vision' || cand.phrased) return cand;
  if (reasoningMode === 'mock') return cand;
  const { lastEvents, answered } = recentContext(room);
  const sys = `You are a patient apprentice learning a workflow by watching an expert work.
Ask ONE short spoken question (max 20 words) that reveals the REASON or a GUARDRAIL behind
what just happened on screen — never something the screen already shows. Be warm and concise;
the expert is experienced and busy. Return JSON: {"q":"...","guardrail":true|false}.`;
  const usr = `Recent screen events:\n${lastEvents.join('\n')}\nAlready asked/answered:\n${answered.join('\n') || '(none)'}\nDraft question: ${cand.q}\nImprove it.`;
  const out = parseJSON(await claude(sys, usr, 200), null);
  if (!out || !out.q) return cand;
  return { ...cand, q: out.q, guardrail: typeof out.guardrail === 'boolean' ? out.guardrail : cand.guardrail };
}

// 2–3 questions the STUDENT might want to ask, given what's on screen.
export async function studentSuggestions(room) {
  const last = room.events[room.events.length - 1];
  if (reasoningMode === 'mock') return mockSuggestions(room, last);
  const { lastEvents, answered, screenSummary } = recentContext(room);
  const sys = `You help a new hire watch an expert work. Suggest 2-3 SHORT questions
(max 12 words each) the new hire could ask the expert to understand the reasoning or the
rules — the kind a beginner wouldn't think to ask. Ground them in the latest visible screen
state even if the expert is in an arbitrary browser tab or desktop app. Avoid questions already answered.
Return JSON: {"questions":["...","..."]}.`;
  const usr = `Current screen state:\n${screenSummary || '(not yet summarized)'}\nRecent screen events:\n${lastEvents.join('\n') || '(none)'}\nAlready answered:\n${answered.join('\n') || '(none)'}`;
  const out = parseJSON(await claude(sys, usr, 220), null);
  const qs = out && Array.isArray(out.questions) ? out.questions : null;
  return qs ? qs.slice(0, 3).map((q) => ({ q })) : mockSuggestions(room, last);
}
function mockSuggestions(room, last) {
  const out = [];
  if (last && /cost center/.test(last.text)) out.push({ q: 'Why that cost center and not another?' });
  if (last && /held/.test(last.text)) out.push({ q: 'When would you release a hold?' });
  if (last && /2nd approval|second/.test(last.text)) out.push({ q: 'Who is the second approver, and why?' });
  if (last && /approved/.test(last.text)) out.push({ q: 'What would have made you stop instead?' });
  out.push({ q: 'Is there a limit where you’d ask someone?' });
  out.push({ q: 'What mistake do new people make here?' });
  // de-dup against answered
  const asked = new Set(room.qa.map((x) => x.q));
  return out.filter((x) => !asked.has(x.q)).slice(0, 3);
}


// When the Student has been quiet for a while during a live share, generate one
// lightweight spoken question for the Guide. This text-only Claude call uses the
// latest compact vision state, so it works across arbitrary tabs without sending
// another screenshot. The browser voices the resulting question with ElevenLabs.
export async function idleGuideQuestion(room) {
  const { lastEvents, answered, screenSummary } = recentContext(room);
  const hasSharedFrame = !!room.latestFrame;
  if (!screenSummary && !lastEvents.length && !hasSharedFrame) return null;
  if (reasoningMode === 'mock' || (!screenSummary && !lastEvents.length)) {
    const n = room.qa.filter((x) => x.stepKey === 'screen_idle').length;
    const prompts = [
      'What are you looking for on this screen before you make your next move?',
      'What would make you choose a different next step here?',
      'What is the main signal on this screen that a new hire might miss?',
    ];
    return {
      key: `idle:visible-work:${n}`,
      q: prompts[n % prompts.length],
      guardrail: false, stepKey: 'screen_idle', invId: null, source: 'idle', phrased: true,
    };
  }
  const sys = `You are an AI apprentice watching an expert's shared screen. The learner has been quiet.
Ask ONE natural spoken question (max 18 words) that helps expose the expert's intent, reasoning,
selection criteria, or a guardrail behind what is currently visible. The shared content may be any
browser tab or desktop app. Do not ask for a fact already visible on screen and do not mention secrets.
Avoid repeating prior questions. Return JSON: {"q":"...","guardrail":true|false,"key":"short-key"}.`;
  const usr = `Current screen state:\n${screenSummary || '(no compact state)'}\nRecent visible activity:\n${lastEvents.join('\n') || '(none)'}\nPrior questions/answers:\n${answered.slice(-8).join('\n') || '(none)'}`;
  const out = parseJSON(await claude(sys, usr, 220), null);
  if (!out || typeof out.q !== 'string' || !out.q.trim()) return null;
  const q = out.q.trim().slice(0, 220);
  const keyText = String(out.key || q.toLowerCase().replace(/[^a-z0-9]+/g, '-')).slice(0, 90);
  return {
    key: `idle:${keyText}`, q, guardrail: !!out.guardrail, stepKey: 'screen_idle',
    invId: null, source: 'idle', phrased: true,
  };
}

// Build the shared curriculum from the locked Work Map.
export async function buildCurriculum(room) {
  const steps = buildWorkMap(room);
  const teach = teachInvoice();
  const base = {
    title: 'Workflow curriculum — invoice processing',
    summary: `Captured from a live session: ${steps.length} steps, ${steps.filter((s) => s.hasGuard).length} guardrails.`,
    lessons: steps.map((s, i) => ({
      n: i + 1,
      title: s.title,
      did: s.decision,
      reason: s.reason,
      guardrail: s.guardrail,
      check: `When would you NOT do what the guide did on ${s.invId}?`,
    })),
    practice: {
      prompt: `Process ${teach.id} (${teach.supplier}, €${teach.amount.toLocaleString('de-DE')}) the way your guide would.`,
      teach,
    },
  };
  if (reasoningMode === 'mock') return base;
  // Enrich narrative + checks with Claude, keep structure stable.
  const sys = `Turn these captured workflow steps into a short practice curriculum for a new hire.
Keep the guide's reasons verbatim. For each lesson add a one-line "check" question that tests judgment.
Return JSON: {"summary":"...","lessons":[{"n":N,"title":"...","did":"...","reason":"...","guardrail":"...","check":"..."}]}`;
  const usr = JSON.stringify(base.lessons);
  const out = parseJSON(await claude(sys, usr, 900), null);
  if (out && Array.isArray(out.lessons) && out.lessons.length) {
    return { ...base, summary: out.summary || base.summary, lessons: out.lessons, practice: base.practice };
  }
  return base;
}

// Coaching feedback after a practice decision (optional Claude flourish).
export async function practiceFeedback(room, verdict) {
  if (reasoningMode === 'mock' || verdict.ok) return verdict;
  const sys = `You are coaching a new hire ON BEHALF OF their guide. In one warm sentence,
explain why the decision was wrong using the guide's own reasoning. Return JSON {"message":"..."}.`;
  const usr = `Guide's rule: ${verdict.guardrail}\nWhat the new hire did: ${verdict.scoreNote}`;
  const out = parseJSON(await claude(sys, usr, 150), null);
  return { ...verdict, question: out && out.message ? out.message : verdict.question };
}
