# The AI Apprentice

A **real-time, two-party** app for passing on expert judgment. One person opens a room as the **Guide**, does a real task, and shares a code; another joins as the **Student** and follows along live. The apprentice (AI) watches the Guide, asks *why* at the right moments, **suggests questions the Student may not know to ask**, and after the session builds a **shared curriculum** the Student practices against — with the AI coaching on the Guide's behalf.

Roles are generic: whoever opens the room is the Guide, whoever joins is the Student. No names are hardcoded.

Built for the Hack‑Nation × ElevenLabs challenge *"The AI Apprentice."*

---

## What it does

- **Live session (both pages, synced).** The Guide works a task; the Student sees every action and the Guide's shared screen in real time. Either side can talk by **voice or text** at any moment.
- **The AI paces itself.** It asks the Guide one question at a time, only after a pause — never a pile of questions at once, so an experienced (and busy) expert is never overwhelmed.
- **The AI helps the Student ask.** Because a beginner often doesn't know what to ask, the Student gets 2–3 tappable suggested questions that update as the work unfolds; tapping one sends it to the Guide.
- **Curriculum, shared.** When the Guide confirms the teach‑back, a curriculum is generated and appears on **both** pages: one lesson per step (what was done, why in the Guide's words, the guardrail, a judgment check), plus an agent‑ready JSON export.
- **Practice, coached.** The Student works a case the Guide never showed. The AI steps in **before** a guardrail is broken, explaining it with the Guide's reasoning, and shows a mastery scorecard.
- **Trust controls.** Off‑the‑record answers and PII redaction on both sides.

## Two APIs (with keyless fallback)

| Capability | Live provider | Keyless fallback |
|---|---|---|
| Voice (ask/answer aloud) | **ElevenLabs** ElevenAgents + TTS | browser Web Speech |
| Screen → events | **Claude** vision | the sandbox ERP emits ground‑truth events |
| Question phrasing, Student suggestions, curriculum | **Claude** | deterministic templates |

Deterministic triggers decide *when* there's something worth asking (reliable on stage); Claude phrases it well and generates suggestions + curriculum; ElevenLabs voices it. **No `npm install` and no keys required to run** — the server is pure Node built‑ins + `fetch`.

---

## Quick start

```bash
unzip ai-apprentice.zip && cd ai-apprentice
node server/index.js            # or: npm start
```

Open **http://localhost:8787** in Chrome.

1. Click **Open a room** → you're the **Guide**. Copy the room code (top bar).
2. In a second browser/tab/device, open the same URL, enter the code, **Join** → you're the **Student**.
3. As the Guide, process the three invoices. Answer the apprentice's questions by voice or text. The Student watches live and can ask too.
4. When prompted, run the **debrief**, confirm the **teach‑back** → the **curriculum** appears on both pages.
5. As the Student, click **Practice this now** and try the unseen case.

Tip: the Guide's room‑code pill copies a ready‑to‑send Student invite link.

Run the brain tests: `npm test`. Two‑browser e2e: `node test/e2e.mjs` (needs Playwright + a running server).

### Going live (optional)

```bash
cp .env.example .env     # add ANTHROPIC_API_KEY and/or ELEVENLABS_* keys
node --env-file=.env server/index.js
```

The top‑bar mode pill flips from `mock/mock` to the live providers. With a vision key, the Guide's **Share real screen** streams frames to Claude, which turns them into events the Student sees — so the app works for *any* screen task, not just the sandbox.

---

## How it maps to the challenge

| Apprentice‑Test question | Where |
|---|---|
| **When to ask** | `planner.shouldSpeak` + the room watcher — one question, only after a pause, never while the Guide is talking. |
| **What to ask** | `planner.questionFor` (triggers) + `reasoning.phraseGuideQuestion` (Claude wording) — only *why/guardrail*, never what the screen shows. |
| **When it has understood** | `planner.coverage`/`isUnderstood` live checklist → debrief → teach‑back the Guide confirms. |
| **Whether the new hire learned** | Practice on an unseen case + mastery scorecard. |
| **Trust** | off‑the‑record + `redact.js`. |

Plus the real‑time collaboration, the Student‑suggestion reasoning, and the shared curriculum the brief's stretch/moonshot sections point to.

## Project layout

```
server/
  index.js            HTTP + room API + per-room SSE broadcast (Node built-ins only)
  lib/
    room.js           rooms, roles, broadcast, pacing watcher, curriculum, practice
    reasoning.js      Claude: question phrasing, student suggestions, curriculum (mock fallback)
    planner.js        when/what to ask, coverage, teach eval        (pure, tested)
    workmap.js        events + Q&A -> Work Map + agent JSON          (pure, tested)
    redact.js         PII redaction                                  (pure, tested)
    scenario.js       sandbox ERP invoices + the unseen practice case
    vision.js         frame -> events via Claude (fetch), mock fallback
    voice.js          ElevenLabs signed URL + TTS (fetch), mock fallback
web/
  index.html          landing: open a room / join a room
  room.html           shared shell for both roles
  app.js              role-aware client (guide view, student view, practice)
  styles.css
test/
  run.mjs             dependency-free brain tests
  e2e.mjs             two-browser Guide+Student real-time walkthrough
```

## Key room API

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/room` | open a room → `{code}` |
| GET | `/api/room/:code/stream?role=guide\|student` | **SSE** broadcast |
| POST | `/api/room/:code/change` | a Guide ERP change (open/cc/action) |
| POST | `/api/room/:code/chat` | a message from `guide` or `student` |
| POST | `/api/room/:code/frame` · `/api/vision` | relay / analyze a shared screen frame |
| POST | `/api/room/:code/debrief` · `/confirm` | run debrief / build curriculum |
| POST | `/api/room/:code/practice` · `/practice-attempt` | student practice |
| GET | `/api/room/:code/export` | agent‑ready Work Map JSON |

## License

MIT — see `LICENSE`.
