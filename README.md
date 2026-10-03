# The AI Apprentice

A working MVP for the Hack-Nation × ElevenLabs "AI Apprentice" challenge: an apprentice that
watches an expert work, asks why at the right moments, maps the workflow into a clickable Work
Map, and teaches the next hire what the expert knows.

Built with Next.js (App Router), the ElevenLabs Agents Platform (Scribe v2 Realtime turn-taking +
Expressive Mode voice), and Claude (vision-diffing the shared screen, synthesizing the Work Map).

## The three modules

1. **Capture** (`/capture`) — the expert shares their screen and talks through a real task. Every
   ~1.6s a frame is diffed by a vision model into a structured event ("invoice 4471 cost center
   changed from 4711 to 0400"). The ElevenLabs agent receives these as silent contextual updates
   and stays quiet until a pause is detected, then decides whether to ask — at least 3 live
   questions per session, at least 1 about a guardrail.
2. **Map** (`/map/[sessionId]`) — once capture ends, a spoken debrief asks about anything still
   unclear, then teaches the whole process back to the expert for confirmation. Claude merges the
   event log, live Q&A, and debrief transcript into a Work Map: ordered steps, each with its
   screen moment, decision, reason (quoted in the expert's words), and guardrails.
3. **Teach** (`/teach/new?source=<sessionId>` → `/teach/[teachSessionId]`) — a new hire works a
   fresh case on their own screen while a tutor agent (loaded with the Work Map) explains steps,
   asks them to predict decisions, and flags it live if they're about to break a guardrail —
   before they save.

A self-contained fake ERP at `/sandbox?set=a` (expert case) and `/sandbox?set=b` (new-hire case,
including a fresh capex trap the expert never showed) means you don't need WebArena or any other
sandbox — just open it in a second tab and share that tab when prompted.

## Setup

```bash
npm install
cp .env.example .env.local
# fill in ANTHROPIC_API_KEY and ELEVENLABS_API_KEY in .env.local
npm run create-agents   # provisions the two ElevenLabs agents, writes their ids back to .env.local
npm run dev
```

If `create-agents` fails because the ElevenLabs REST shape has moved on, create the two agents by
hand at [elevenlabs.io/app/agents](https://elevenlabs.io/app/agents) using the system prompts and
client tools defined in `scripts/create-agents.ts`, then paste the resulting agent ids into
`.env.local` as `ELEVENLABS_INTERVIEWER_AGENT_ID` / `ELEVENLABS_TUTOR_AGENT_ID`.

## How it's wired

- `src/lib/useScreenCapture.ts` — `getDisplayMedia`, samples a frame every ~1.6s, calls
  `/api/vision/frame` (Claude vision diffs it against the previous frame into a structured event
  or "no change"), and detects a **pause**: no visual change for 3s.
- `/api/vision/frame` — the vision-diffing module described in the brief: turns frames into
  events, not video.
- Capture/Teach pages push each event into the ElevenLabs conversation via
  `sendContextualUpdate` (silent — doesn't trigger a response) and nudge on pause; the agent's own
  system prompt decides whether that pause is worth a question.
- The agent calls the `log_question` client tool every time it asks a substantive question, so the
  UI can show live coverage against the "≥3 questions, ≥1 guardrail" requirement.
- `/api/workmap/build` — forces Claude to emit a structured Work Map via tool-calling (not freeform
  JSON parsing) from the event log + live Q&A + debrief transcript.
- The tutor agent gets the Work Map as a contextual update at session start, and calls
  `flag_guardrail_risk` / `replay_screen_moment` / `mark_mastery` client tools that the UI renders
  directly (guardrail alert banner, expert-screen-moment replay with the stored thumbnail,
  mastered/practice-next summary).

Session state is stored as JSON under `data/` (gitignored — may contain PII from the shared
screen) rather than a database, since this is a single-demo MVP.

## The Apprentice Test — how this MVP answers it

1. **When to ask.** `useScreenCapture` tracks time since the last *visual* change (not time since
   last keystroke, which isn't observable from screen share) and fires `onPause` after 3s of no
   change. That's sent as a contextual update; the agent's system prompt explicitly tells it to
   stay silent otherwise and to only speak on a pause signal when something is worth asking.
2. **What to ask.** The agent only ever sees factual screen-diff events, never raw video, and its
   prompt requires every live question to reference the specific event just seen — never a generic
   "how's it going." It must cover why/guardrail/exception question types and logs each one via
   `log_question`, which the UI checks live.
3. **When it has understood.** The debrief mode (triggered by a contextual update once capture
   ends) keeps asking about open gaps, then must deliver a full teach-back and get the expert's
   confirmation before calling `mark_teachback_done` — which is what triggers Work Map generation.
4. **Whether the new hire learned.** `/teach` runs a second, independent screen-share session on a
   case the expert never showed (`sandbox?set=b`). The tutor must catch a wrong decision live via
   `flag_guardrail_risk` *before* it's saved, and the end-of-session summary shows mastered vs.
   practice-next topics from `mark_mastery` calls.
5. **Trust.** The "Take this off the record" toggle on the Capture page mutes both the vision
   pipeline and the agent's mic mid-session (tracked as `offTheRecordRanges` on the session, so
   it's auditable that nothing was captured during that window). All text that reaches storage —
   event summaries and transcripts — passes through `src/lib/redact.ts`, a regex-based PII
   redactor for emails/phones/IBANs/card numbers, standing in for the brief's suggested Presidio
   pipeline (swap it for real Presidio before using this on a non-demo workflow).

## Moonshot

Today's MVP captures one expert, one task, one new hire, stored as an isolated JSON file per
session. The natural next step is a **living company memory**: every capture session merges into
one Work Map per workflow instead of a new one each time, so the apprentice only has to ask about
what changed since the last expert touched that process. From there, the same guardrail data that
teaches a new hire is structured enough to export as **agent-ready instructions** (the stretch
goal) — letting an agent take the routine steps safely while people keep the judgment calls.

## Known limitations of this MVP

- `scripts/create-agents.ts` targets the ElevenLabs Conversational AI REST shape as of this
  writing; if it 404s/400s, use the dashboard fallback described above.
- The vision-diff call runs synchronously per frame (~1.6s cadence); very fast UI changes between
  samples can be missed, same as the brief's own "a frame every one to two seconds" guidance.
- PII redaction is regex-based, not NER — good enough for a sandboxed demo, not for real invoices.
