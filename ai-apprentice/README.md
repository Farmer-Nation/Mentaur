# Mentaur — AI Apprentice

**Mentaur** is a real-time, two-party app for passing on expert judgment. One person opens a room as the **Guide**, does a real task, and shares a code; another joins as the **Student** and follows along live. The apprentice (AI) watches the Guide, asks *why* at the right moments, **suggests questions the Student may not know to ask**, and after the session builds a **shared curriculum** the Student practices against — with the AI coaching on the Guide's behalf.

Roles are generic: whoever opens the room is the Guide, whoever joins is the Student. No names are hardcoded.

Branded as **Mentaur** and built for the Hack‑Nation × ElevenLabs challenge *"The AI Apprentice."*

---

## What it does

- **Live session (both pages, synced).** The Guide works a task; the Student sees every action and the Guide's shared screen in real time. Either side can talk by **voice or text** at any moment.
- **The AI paces itself.** It asks the Guide one question at a time, only after a pause — never a pile of questions at once, so an experienced (and busy) expert is never overwhelmed.
- **The AI helps the Student ask.** Because a beginner often doesn't know what to ask, the Student gets 2–3 tappable suggested questions that update as the work unfolds; tapping one sends it to the Guide.
- **Curriculum, shared.** When the Guide confirms the teach‑back, a curriculum is generated and appears on **both** pages: one lesson per step (what was done, why in the Guide's words, when to stop, and a judgment check), plus an agent‑ready JSON export.
- **Practice, coached.** The Student works several cases the Guide never showed. The AI steps in **before** an unsafe choice, explaining it with the Guide's reasoning, and shows a mastery scorecard.
- **Trust controls.** Off‑the‑record answers and PII redaction on both sides.

## Two APIs (with keyless fallback)

| Capability | Live provider | Keyless fallback |
|---|---|---|
| Voice output | **ElevenLabs TTS** (Flash v2.5 by default) | browser Web Speech |
| Screen → events + live questions | **Claude vision** (Haiku by default) | the sandbox ERP emits ground‑truth events |
| Sandbox question phrasing + curriculum | **Claude** | deterministic templates |

For the sandbox, deterministic triggers decide *when* there is something worth asking. For **any shared screen**, Claude analyzes the visible state and proposes the best grounded reason or "when to stop" question. ElevenLabs voices replies when available. **No `npm install` and no keys required to run** — the server is pure Node built-ins + `fetch`.

---

## Quick start

```bash
unzip ai-apprentice.zip && cd ai-apprentice
node server/index.js            # or: npm start
```

Open **http://localhost:8787** in Chrome.

1. Click **Open a room** → you're the **Guide**. Copy the room code (top bar).
2. In a second browser/tab/device, open the same URL, enter the code, **Join** → you're the **Student**.
3. As the Guide, review the three inventory items and choose stock, reorder, or quarantine. Each item includes a count, condition, location, and receiving note. Answer the apprentice's questions by voice or text. The Student watches live and can ask too.
4. When prompted, run the **debrief**, confirm the **teach‑back** → the **curriculum** appears on both pages.
5. As the Student, click **Practice this now** and try the unseen case.

Tip: the Guide's room‑code pill copies a ready‑to‑send Student invite link.

Run the brain tests: `npm test`. Two‑browser e2e: `node test/e2e.mjs` (needs Playwright + a running server).

### Going live (optional)

Create a local `.env` from the template and add the keys there. Do not put keys in
`web/` or commit them to `.env.example`.

PowerShell:

```powershell
Copy-Item .env.example .env
notepad .env
node --env-file=.env server/index.js
```

Set these values in `.env`:

```dotenv
# Enables Claude screen analysis, question phrasing, suggestions, and curriculum enrichment.
ANTHROPIC_API_KEY=your_anthropic_key

# Enables ElevenLabs spoken replies. The browser speech fallback remains available without it.
ELEVENLABS_API_KEY=your_elevenlabs_key
ELEVENLABS_VOICE_ID=EXAVITQu4vr4xnSDxMaL
ELEVENLABS_TTS_MODEL=eleven_flash_v2_5

# Optional: only needed for the ElevenLabs Conversational AI signed-url endpoint.
ELEVENLABS_AGENT_ID=
```

The app reads these keys only on the Node server. The browser calls the local
`/api/vision`, `/api/voice/tts`, and `/api/voice/signed-url` endpoints, so provider
keys are never sent to the browser. You can run with only one provider:

```powershell
# Claude only: voice uses browser Web Speech
node --env-file=.env server/index.js
```

The top-bar mode pill shows the active paths, for example `claude/elevenlabs` or `mock/local`. With an Anthropic key, the Guide's **Share real screen** works with any visible desktop/browser task. The Guide gets a large self-preview in the main workspace while sharing. The browser samples screen activity locally every ~1.5 seconds, relays changed frames to the Student, and sends a compressed changed frame to Claude after a configurable throttle (4 seconds by default). Claude returns a chat-ready activity summary, events, a grounded Guide question, and Student question suggestions in the same call. Live summaries are persisted in the conversation at most once per minute; suggested questions can refresh more frequently from the latest compact screen state. If the learner stays quiet, Mentaur periodically asks the Guide a screen-grounded question and voices it with ElevenLabs when configured. The idle-question cadence also stays active when a non-demo tab is shared but a vision summary is temporarily unavailable. Use **Pause share / Resume share** to freeze screen relay and analysis, and **Pause questions / Resume questions** to disable or re-enable apprentice interruptions without ending the share.

While Mentaur is speaking, turn on **Record Guide** and say “thank you Mentaur”
(or “thanks mentor”) to interrupt playback. Student typed questions and suggested
question buttons are spoken aloud on the connected pages. The same pause-gated
planner is used for the simulation; Claude vision supplies the questions for a
real shared screen.

If a key was ever pasted into a committed or shared file, revoke it in the
Anthropic/ElevenLabs dashboard and create a replacement before running the app.

---

## How it maps to the challenge

| Apprentice‑Test question | Where |
|---|---|
| **When to ask** | Local screen activity + `planner.shouldSpeak` + the room watcher. High-value visible decisions can trigger quickly; when the learner has been quiet, an idle cadence queues a grounded prompt using a shorter quiet gap. Typing, active TTS, pending questions, Share Pause, and Question Mode still suppress interruptions. |
| **What to ask** | Sandbox: `planner.questionFor`. Any shared screen: Claude vision returns a screen-grounded question; the idle path can also use text-only Claude reasoning over the latest compact screen state so it works across arbitrary tabs without another screenshot. |
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
    scenario.js       sandbox inventory items, evidence notes, and the unseen practice case
    vision.js         arbitrary screen -> events/questions via Claude; one-image low-credit calls
    voice.js          ElevenLabs TTS first, graceful local-TTS fallback
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
| POST | `/api/room/:code/share-state` | pause/resume screen relay + analysis state |
| POST | `/api/room/:code/question-mode` | pause/resume automatic apprentice questions |
| POST | `/api/room/:code/debrief` · `/confirm` | run debrief / build curriculum |
| POST | `/api/room/:code/practice` · `/practice-attempt` | student practice |
| GET | `/api/room/:code/export` | agent‑ready Work Map JSON |

## Low-credit screen analysis

The real-screen path deliberately separates **sampling** from **paid inference**:

1. A tiny 32×18 browser thumbnail is compared locally every ~1.5 seconds.
2. Visual changes send a free activity ping so Mentaur knows the expert is still working and stays quiet.
3. Changed frames are relayed to the Student without Claude.
4. Claude sees one compressed 720px-wide JPEG only when the screen is dirty **and** `VISION_INTERVAL_MS` has elapsed.
5. That Claude response supplies the compact screen state, a chat-ready activity summary, events, a Guide question, and up to three Student suggestions.
6. Activity summaries are appended to the room chat; learner suggestions can refresh every few seconds from the compact state without another image call.
7. After learner silence, the watcher reuses a recent Claude vision question or asks text-only Claude for a fresh one; the Guide client voices it through ElevenLabs when enabled.

For hackathon demos, use fake/sandbox data when sharing a real screen. The app avoids intentionally repeating obvious secrets in Claude output, but screenshots sent to a configured vision API are still external API inputs.

## License

MIT — see `LICENSE`.
