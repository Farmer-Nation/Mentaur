<div align="center">
  <img src="https://github.com/Farmer-Nation/Mentaur/blob/main/mentaur-logo.png?raw=true" alt="Mentaur logo" width="110" />
  <h1>Mentaur</h1>
  <p><strong>Screen-aware AI apprenticeship platform built with Node.js, Supabase, Claude, and ElevenLabs.</strong></p>
  <p>
    Because every great human deserves their other half.
    </br></br>Try it out: https://hacknation-30mb.onrender.com/
  </p>
</div>

## Why Mentaur

Most workplace knowledge is not written down.

Experienced people make decisions based on context, exceptions, warning signs, and judgment they have accumulated over years. Traditional documentation captures the steps, but often misses the reasoning behind them.

Mentaur treats knowledge transfer as a **Capture → Map → Teach** workflow:

- a Teacher shares their real work screen
- Mentaur watches meaningful screen changes instead of recording everything
- the AI asks questions about decisions, signals, exceptions, and guardrails
- the session is reconstructed into a reusable **Work Map**
- Learners can practice, ask questions live, and later query knowledge from the teaching sessions they actually attended

The goal is to turn tacit expert judgment into structured knowledge that can continue teaching after the original session ends.

## Core features

- **Authenticated Teacher / Learner accounts**
  - Supabase Auth provides persistent email/password accounts
  - roles are stored in server-verified profiles rather than trusted from the browser
  - Teachers create sessions while Learners join using a room code

- **Live shared-screen AI observation**
  - Teachers can share any browser tab, application, document, spreadsheet, terminal, or other work screen
  - the client detects meaningful visual changes before sending a frame for analysis
  - Claude Vision returns compact screen context, workflow events, activity summaries, and grounded questions

- **Reasoning-first questioning**
  - Mentaur focuses on questions such as **why**, **what would change the decision**, and **when should someone stop and ask for help**
  - questions are held until the Teacher pauses instead of interrupting active work
  - Question Mode can pause automatic prompts when the Teacher needs uninterrupted time

- **Work Map generation**
  - captured screen events and Teacher explanations are transformed into structured workflow knowledge
  - the Work Map connects observed actions with reasoning, evidence, and guardrails
  - a debrief fills remaining knowledge gaps before the Teacher confirms the result

- **Live learner participation**
  - Teacher and Learner views stay synchronized through Server-Sent Events
  - Learners can ask questions during the session
  - Mentaur also suggests useful questions based on what is currently happening on screen

- **Coached practice**
  - the project includes a multi-case inventory training simulation for practicing captured decision rules
  - Mentaur intervenes when a Learner is about to violate a guardrail
  - feedback is framed as a coaching question rather than immediately revealing the answer

- **Persistent private knowledge base**
  - teaching sessions are converted into searchable knowledge chunks in Supabase
  - Learners can query knowledge only from sessions they actually attended
  - answers are grounded in retrieved session evidence and include source metadata
  - Teachers can review their saved teaching-session library

- **Voice + multilingual support**
  - ElevenLabs provides spoken Mentaur responses when configured
  - browser speech synthesis provides a fallback when ElevenLabs is unavailable
  - room text supports English, Japanese, and Vietnamese translation through Claude

- **Privacy-aware capture**
  - optional OCR-based redaction can mask sensitive text before a shared frame is analyzed
  - Teachers can mark the next response as **Private / off the record**
  - raw screen frames are not written into the persistent knowledge base

## Technical highlights

### 1) Cost-aware vision over arbitrary shared screens

Sending continuous screenshots to a vision model would be expensive and unnecessary.

Mentaur uses a staged pipeline:

- the browser creates a lightweight **32×18 visual fingerprint**
- unchanged frames are ignored locally
- changed frames are throttled before model analysis
- only one compressed current image is sent to Claude
- the previous screen state is represented as a compact text summary instead of another screenshot

A single Claude Vision response can produce:

- current screen context
- a live activity summary
- meaningful workflow events
- the next Teacher question
- suggested Learner questions

This keeps the screen-understanding loop responsive without paying for continuous duplicate vision requests.

### 2) Question timing is separated from question generation

Mentaur has two separate problems to solve:

1. **What should the AI ask?**
2. **When should it ask without becoming annoying?**

The planner explicitly separates those concerns.

Candidate questions target missing reasoning or guardrails, while the timing layer waits until:

- the Teacher has paused
- the Teacher is not typing
- Mentaur is not already speaking
- another question is not currently pending
- Question Mode is not paused

This creates a more realistic apprenticeship interaction than a chatbot that responds after every UI event.

### 3) Server-enforced authorization with real-time room sync

The browser never gets to declare that it is a Teacher or Learner.

Supabase stores the account role, and the Node server maps that verified role into room permissions.

Examples:

- only Teachers can create rooms
- only Learners can join teaching rooms
- only the owning Teacher can control screen sharing, vision analysis, debriefs, and Work Map confirmation
- Learners can access only rooms they joined
- room events are streamed through authenticated **Server-Sent Events**

Authentication tokens stay in `HttpOnly`, `SameSite=Lax` cookies, so live EventSource connections can authenticate without placing access tokens in URLs or browser storage.

### 4) Learner-scoped knowledge retrieval without paid embeddings

Mentaur persists structured session knowledge into Supabase as chunks including:

- session overview
- observed workflow events
- conversation transcript
- Teacher Q&A
- Work Map steps
- curriculum content

Postgres full-text search retrieves a small evidence set from sessions associated with the authenticated Learner.

Claude then answers using only that evidence.

This architecture avoids requiring an embedding provider while still providing:

- indexed retrieval with a Postgres GIN index
- session-level access control
- grounded answers
- source attribution
- predictable context size
- a 15-minute cache for repeated questions against unchanged context

It is a pragmatic RAG architecture for a hackathon-scale product.

### 5) Privacy and graceful degradation are built into the pipeline

Mentaur is designed so external AI services improve the experience without becoming the only thing keeping it alive.

Privacy controls include:

- OCR-based sensitive-text detection before screen frames are sent for analysis
- server-side redaction of persisted textual knowledge
- a one-answer **off-the-record** mode
- no persistent storage of raw shared-screen images

Provider fallbacks include:

- mock/local reasoning behavior when Claude is unavailable
- local browser speech synthesis when ElevenLabs TTS fails
- bounded knowledge retrieval and model output sizes
- throttled knowledge persistence instead of writing after every event

The result is a system that degrades toward simpler functionality instead of immediately hard-failing.

## Tech stack

| Layer | Tools |
|---|---|
| Frontend | Vanilla JavaScript, HTML5, CSS |
| Backend API | Node.js 22, native HTTP server |
| Real-time sync | Server-Sent Events / EventSource |
| Authentication | Supabase Auth |
| Database | Supabase Postgres |
| Knowledge retrieval | PostgreSQL full-text search + GIN index |
| AI reasoning | Anthropic Claude |
| Screen understanding | Claude Vision |
| Translation | Claude |
| Voice | ElevenLabs TTS, Web Speech fallback |
| Screen privacy | Tesseract.js OCR + client-side redaction |
| Optional scraping | Puppeteer Core, Bright Data |
| Testing | Node.js test scripts + browser E2E flow |

## Architecture overview

```text
ai-apprentice/
  server/
    index.js
      -> authenticated HTTP + SSE API
      -> static frontend serving
      -> room, vision, voice, knowledge, and auth routes

    lib/
      room.js
        -> live room state
        -> event broadcasting
        -> debrief + practice flow
        -> background question watcher

      planner.js
        -> question selection
        -> pause-aware question timing
        -> knowledge-gap / guardrail logic
        -> practice evaluation

      reasoning.js
        -> Claude reasoning
        -> debrief generation
        -> learner coaching
        -> grounded knowledge-base answers

      vision.js
        -> Claude shared-screen analysis
        -> activity summaries
        -> workflow events
        -> Teacher + Learner question generation

      workmap.js
        -> captured session -> structured Work Map
        -> agent-ready workflow export

      knowledge.js
        -> Supabase session archives
        -> knowledge chunk construction
        -> Postgres FTS retrieval
        -> answer caching

      supabase.js
        -> Supabase Auth + REST adapter
        -> HttpOnly cookie sessions
        -> service-role database operations

      authz.js
        -> Teacher / Learner authorization rules

      voice.js
        -> ElevenLabs TTS
        -> local browser fallback support

      translate.js
        -> English / Japanese / Vietnamese text translation

      redact.js
        -> persisted-text redaction

      scrape.js
        -> optional Bright Data browser scraping

  web/
    index.html
      -> authentication + role selection

    dashboard.js
      -> Teacher / Learner dashboard behavior

    room.html
    app.js
      -> live teaching room
      -> screen sharing
      -> local change detection
      -> OCR redaction
      -> conversation + Work Map + practice UI

    knowledge.html
    knowledge.js
      -> Learner knowledge chatbot
      -> Teacher session library

  supabase/
    migrations/
      001_mentaur_auth_knowledge.sql
        -> profiles
        -> teaching sessions
        -> participants
        -> archives
        -> knowledge chunks
        -> RLS policies
        -> full-text search RPC

  test/
    run.mjs
      -> unit / integration coverage

    e2e.mjs
      -> authenticated Teacher + Learner browser flow
```

## Local setup

### 1) Requirements

- Node.js **22.x**
- npm
- a Supabase project
- an Anthropic API key for live Claude reasoning / vision
- an ElevenLabs API key if you want ElevenLabs voice output

Supabase is required for the authenticated account and persistent knowledge-base flow.

Claude and ElevenLabs have fallback behavior when their API keys are not configured.

### 2) Create the Supabase schema

Create a Supabase project and run:

```text
supabase/migrations/001_mentaur_auth_knowledge.sql
```

through the Supabase SQL editor or Supabase CLI.

The migration creates the authentication profiles, teaching sessions, participant relationships, archives, searchable knowledge chunks, RLS policies, and full-text-search function used by Mentaur.

### 3) Configure environment variables

Create an `.env` file inside `ai-apprentice/`:

```env
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

ANTHROPIC_API_KEY=
ELEVENLABS_API_KEY=

PORT=8787
```

Optional model configuration:

```env
VISION_MODEL=claude-haiku-4-5
REASONING_MODEL=claude-haiku-4-5
ELEVENLABS_TTS_MODEL=eleven_flash_v2_5
```

The Supabase service-role key, Anthropic key, and ElevenLabs key are server-side secrets and should never be exposed in frontend JavaScript.

### 4) Install dependencies

```bash
cd ai-apprentice
npm install
```

### 5) Run the app

Load the `.env` file directly with Node:

```bash
node --env-file=.env server/index.js
```

Or export the environment variables through your shell / deployment environment and run:

```bash
npm run dev
```

Then open:

```text
http://localhost:8787
```

### 6) Run tests

```bash
npm test
```

The repository also includes an authenticated browser E2E flow in:

```bash
node test/e2e.mjs
```

## Example user flows

### Teacher flow

1. Create a **Teacher** account and sign in.
2. Create a teaching room.
3. Share the room code with a Learner.
4. Start sharing a real work screen.
5. Work normally while Mentaur watches meaningful changes.
6. Answer Mentaur when it asks about reasoning, exceptions, or when a new hire should stop.
7. Run the final debrief to fill remaining knowledge gaps.
8. Review and confirm the generated Work Map.
9. Open the Knowledge Base later to review saved teaching sessions.

### Learner flow

1. Create a **Learner** account and sign in.
2. Enter the Teacher's room code.
3. Watch the live workflow and ask questions.
4. Use Mentaur's suggested questions when useful.
5. Review the Work Map after the Teacher confirms it.
6. Practice decision-making in the built-in coached training simulation.
7. After the session, open the Knowledge Base.
8. Ask a question across the combined knowledge from teaching sessions you attended.
9. Review the grounded answer and its source session, or listen using ElevenLabs TTS.

## Future improvements

- generalize the coached-practice and generated curriculum layer beyond the current inventory training sandbox
- generate richer multi-step Work Maps for arbitrary shared-screen workflows
- persist active room state so live sessions can survive server restarts and multi-instance deployments
- add hybrid retrieval with structured filters + full-text search + optional embeddings
- strengthen screen-level PII / secret detection beyond OCR pattern matching
- add organization and team-level knowledge spaces
- support reusable training templates derived from multiple expert sessions
- add production observability, rate limiting, and provider-cost dashboards
- expand automated E2E coverage across authentication, screen sharing, knowledge retrieval, and authorization boundaries

## License

MIT
