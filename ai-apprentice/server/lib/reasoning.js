// Reasoning layer. Deterministic triggers (planner) decide WHEN there is
// something worth asking; this module decides HOW to phrase it well and also
// generates (a) suggested questions for the student, who may not know what to
// ask, and (b) the post-session curriculum. Uses Claude when a key is present,
// with deterministic mock fallbacks so everything runs keyless.

import * as planner from './planner.js';
import { buildWorkMap } from './workmap.js';
import { teachInventory, teachInventoryCases } from './scenario.js';

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
  if (!r.ok) throw new Error(`Claude reasoning failed (${r.status}): ${data.error?.message || 'provider rejected the request'}`);
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
  const sys = `You are Mentaur, an apprentice that learns how an experienced teacher makes decisions.
Use the current work evidence, not a fixed script. Ask ONE natural question that uncovers the
teacher's reasoning, signal, tradeoff, exception, or condition for changing course. Make it
specific to the current item or screen. Do not ask for facts already visible. Use plain language,
avoid jargon, and keep it under 28 words. Mark "guardrail" true only when the question is about
when to stop, verify, escalate, or avoid a risky action. Return JSON: {"q":"...","guardrail":true|false}.`;
  const usr = `Current work evidence:\n${lastEvents.join('\n') || '(none)'}
Current screen summary: ${room.screenSummary || '(simulation; use the item evidence in the event)'}
Already asked and answered:\n${answered.slice(-10).join('\n') || '(none)'}
Decision context: ${JSON.stringify(cand.context || {})}`;
  let out;
  try { out = parseJSON(await claude(sys, usr, 200), null); }
  catch (err) { console.warn(`[reasoning] question phrasing unavailable: ${err.message}`); }
  if (!out || !out.q) return cand;
  return { ...cand, q: out.q, guardrail: typeof out.guardrail === 'boolean' ? out.guardrail : cand.guardrail };
}

export async function summarizeAnswer(room, question, answer) {
  if (reasoningMode === 'mock') {
    const idea = String(answer).split(/[.!?]/)[0].trim().replace(/\s+/g, ' ').slice(0, 180);
    return idea ? `Got it — you said: ${idea}.` : 'Got it — thanks for explaining.';
  }
  const sys = `You are Mentaur closing a teaching exchange. Summarize the teacher's answer in
one accurate, warm sentence for the teacher to confirm. Preserve the teacher's meaning, especially
signals, thresholds, exceptions, and tradeoffs. Do not invent details. Return JSON: {"summary":"Got it — ..."}.`;
  const out = parseJSON(await claude(sys, `Question: ${question}\nTeacher answer: ${answer}`, 120), null);
  return out?.summary || (await summarizePlain(answer));
}

async function summarizePlain(answer) {
  const idea = String(answer).split(/[.!?]/)[0].trim().replace(/\s+/g, ' ').slice(0, 180);
  return idea ? `Got it — you said: ${idea}.` : 'Got it — thanks for explaining.';
}

export async function generateDebriefQuestions(room, fallback) {
  if (reasoningMode === 'mock') return fallback;
  const sys = `You are designing a short debrief for a new hire learning a real workflow.
Create only the questions needed to fill missing knowledge from the captured evidence. Ask about
why the teacher chose an action, what evidence mattered, what could change the decision, and when
to stop or ask for help. Avoid repeating answered topics. Return JSON:
{"questions":[{"invId":"... or null","guardrail":true|false,"stepKey":"...","q":"..."}]}.`;
  const context = JSON.stringify({
    items: room.invoices.map((i) => ({ id: i.id, description: i.desc, count: i.amount, condition: i.condition, note: i.note, decision: i.cc, action: i.action, rule: i.truth })),
    answers: room.qa,
  });
  let out;
  try { out = parseJSON(await claude(sys, context, 650), null); }
  catch (err) { console.warn(`[reasoning] debrief generation unavailable: ${err.message}`); }
  if (!out?.questions || !Array.isArray(out.questions)) return fallback;
  return out.questions.filter((q) => q && typeof q.q === 'string' && q.q.trim()).slice(0, 8).map((q, i) => ({
    invId: q.invId || null, guardrail: !!q.guardrail, stepKey: q.stepKey || `debrief_${i}`,
    q: q.q.trim().slice(0, 260),
  }));
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
  const teach = teachInventory();
  const base = {
    title: 'Workflow curriculum — inventory receiving',
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
      prompt: `Process ${teach.id} (${teach.desc}, ${teach.amount} units) the way your guide would.`,
      teach,
    },
  };
  base.practice.cases = teachInventoryCases().map((item) => ({
    id: item.id, title: item.desc, evidence: [item.condition, item.note].filter(Boolean),
  }));
  base.tutorial = [
    { step: 1, title: 'Observe', text: 'Read the count, condition, location, and receiving note before acting.' },
    { step: 2, title: 'Decide', text: 'Choose stock, reorder, or quarantine based on the evidence and the guide’s rule.' },
    { step: 3, title: 'Act', text: 'Complete the matching inventory action and explain the reason.' },
    { step: 4, title: 'Verify', text: 'State the exception that would make you stop and ask for help.' },
  ];
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
  const sys = `You are coaching a new hire through an inventory decision on behalf of an experienced guide.
Do not recite a fixed correction. Use the item's evidence and the guide's rule to ask one short,
friendly thinking question that helps the learner notice the missed signal. Do not reveal the answer
directly. Mention what to check next if the evidence is incomplete. Return JSON {"message":"..."}.`;
  const usr = `Item evidence: ${JSON.stringify(verdict.inv || {})}
Guide's rule: ${verdict.guardrail}
What the new hire did: ${verdict.scoreNote}`;
  const out = parseJSON(await claude(sys, usr, 150), null);
  return { ...verdict, question: out && out.message ? out.message : verdict.question };
}

// Turn a scraped page (from the Bright Data chat widget) into a short, readable
// answer. Falls back to a plain excerpt when no Claude key is configured.
export async function summarizeScrape(url, title, text) {
  const clean = String(text || '').trim();
  if (reasoningMode === 'mock' || !clean) {
    const excerpt = clean.slice(0, 500);
    return `**${title || url}**\n\n${excerpt}${clean.length > 500 ? '…' : ''}`;
  }
  const sys = `Summarize this scraped web page for someone who didn't open it themselves.
Write 3-5 concise sentences covering the most important facts, numbers, or claims.
Do not invent anything that isn't in the page text.`;
  const usr = `URL: ${url}\nTitle: ${title}\nPage text:\n${clean.slice(0, 6000)}`;
  try {
    const out = await claude(sys, usr, 350);
    return out.trim() || clean.slice(0, 500);
  } catch (err) {
    console.warn(`[reasoning] scrape summary unavailable: ${err.message}`);
    return clean.slice(0, 500);
  }
}

export async function answerStudentQuestion(room, question) {
  const steps = buildWorkMap(room);
  if (reasoningMode === 'mock') {
    const relevant = steps.find((s) => `${s.title} ${s.signal} ${s.reason}`.toLowerCase().includes(String(question).toLowerCase().split(/\s+/)[0]));
    return relevant
      ? `Based on the Guide's demo, ${relevant.reason} The safety check is: ${relevant.guardrail}`
      : 'Use the Work Map: observe the quantity, condition, location, and receiving note, then explain which signal supports your decision.';
  }
  const sys = `You are Mentaur coaching a new hire after the Guide has finished the demo.
Answer the student's question using only the captured Work Map, Guide answers, and inventory evidence.
Speak on the Guide's behalf, be practical and encouraging, and help the student reason rather than
just giving a choice. If the evidence is missing, say what to check or who to ask. Return JSON:
{"answer":"one or two concise sentences"}.`;
  const out = parseJSON(await claude(sys, JSON.stringify({ question, steps, qa: room.qa }), 260), null);
  return out?.answer || 'Check the Work Map evidence first, then ask a human if the condition or count is unclear.';
}
