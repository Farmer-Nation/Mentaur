# Mentaur — AI Apprentice

Mentaur is a two-party teaching app with authenticated **Teacher** and **Learner** accounts. Teachers create rooms and are the only users allowed to start/control screen-sharing sessions. Learners join with a room code, ask questions live, and later query a private chatbot built from the combined knowledge of every teacher session they have attended.

## Architecture

- **Supabase Auth + Postgres**: email/password accounts, immutable teacher/learner profile roles, session membership, raw teacher archives, searchable knowledge chunks.
- **Claude**: screen analysis, teaching prompts, curriculum generation, and grounded knowledge-base answers.
- **ElevenLabs**: optional TTS for live Mentaur replies and knowledge-base answers.
- **Browser speech recognition**: spoken learner questions without consuming ElevenLabs STT credits.
- **Server-enforced authorization**: the browser never chooses its own role. Room actions are checked against the authenticated Supabase profile and room ownership/membership.

The app intentionally uses Postgres full-text search instead of paid embeddings. Only a small set of relevant chunks is sent to Claude, and exact repeated knowledge questions are cached in memory for 15 minutes.

## Required setup

### 1. Create the Supabase schema

Create a Supabase project, then run:

`supabase/migrations/001_mentaur_auth_knowledge.sql`

in the Supabase SQL editor (or through the Supabase CLI). The migration creates:

- `profiles` with `teacher` / `learner` role constraints
- `learning_sessions`
- `session_participants`
- `session_archives`
- `knowledge_chunks` with a GIN full-text index
- RLS policies
- `search_learner_knowledge(...)`, executable only by the service role

New accounts are created by the server through the Supabase Admin API with `email_confirm: true`, so users can sign in immediately without clicking an email-verification link. This requires `SUPABASE_SERVICE_ROLE_KEY` and keeps that key server-only.

### 2. Configure environment variables

Copy `.env.example` to `.env` and set at minimum:

```dotenv
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_ANON_KEY=your_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key

ANTHROPIC_API_KEY=your_anthropic_key
ELEVENLABS_API_KEY=your_elevenlabs_key
```

`SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, and `ELEVENLABS_API_KEY` are server-only secrets. Do not put them in `web/` or expose them to browser JavaScript.

Claude and ElevenLabs have graceful local/mock fallbacks, but Supabase is required for the requested account and persistent knowledge-base flow.

### 3. Run

```bash
npm ci
node --env-file=.env server/index.js
# or, after exporting the same environment variables: npm start
```

Open `http://localhost:8787`.

## User flow

### Teacher

1. Create a **Teacher** account and sign in.
2. Start a teaching session. The server creates the live room and matching Supabase `learning_sessions` row.
3. Share the five-character room code with a learner.
4. Start screen sharing. Only the teacher account that owns the room can call the screen/share/debrief/confirm endpoints.
5. Mentaur periodically snapshots textual session knowledge to Supabase and forces a save when sharing ends, debrief starts, and the Work Map is confirmed.
6. Open **Knowledge base** to see saved teaching sessions.

### Learner

1. Create a **Learner** account and sign in.
2. Enter a teacher's room code. Joining records `session_participants(session_id, learner_id)`.
3. Watch the teacher, ask live questions, and practice from the generated Work Map.
4. Open **Knowledge base** and type or speak a question.
5. Supabase retrieves chunks only from sessions that learner joined. Claude answers only from that evidence and returns source labels for the relevant teacher/session.
6. Click **Listen** on an answer to use ElevenLabs TTS. No ElevenLabs call is made automatically on the knowledge page.

## Security model

- Auth tokens are stored in `HttpOnly`, `SameSite=Lax` cookies. They are not placed in query strings or `localStorage`.
- The live `EventSource` stream authenticates with the cookie; the old `?role=guide|student` trust model is removed.
- Teacher/learner roles are created by a Supabase trigger and cannot be changed through client RLS policies.
- A teacher can access only rooms they own. A learner can access only rooms they explicitly joined.
- Screen-share control, frame upload, Claude vision, question-mode, debrief, and confirmation actions are teacher-only.
- The Supabase service-role key never leaves the Node server.
- Raw session archives are teacher-only. Learners retrieve only searchable knowledge chunks from sessions they attended.
- Raw shared-screen image frames are **not persisted** to the knowledge base. Textual screen summaries, events, transcript, Q&A, Work Map, and curriculum are stored instead.
- “Private / off the record” applies to exactly the next teacher answer; it may be heard live but is not written to chat/Q&A/knowledge storage.
- Existing PII redaction is applied before captured text reaches persisted room knowledge when redaction is enabled.

## Credit controls

The implementation is designed to stay light on paid usage:

1. Screen changes are detected locally with a 32×18 fingerprint; Claude vision is only called for dirty frames and is throttled by `VISION_INTERVAL_MS`.
2. `claude-haiku-4-5` remains the default reasoning/vision model.
3. Knowledge retrieval uses Supabase/Postgres full-text search, not paid embedding generation.
4. A knowledge question sends at most 6 chunks, each capped before entering the Claude prompt.
5. Knowledge answers are capped at 500 output tokens.
6. Exact repeated questions against unchanged retrieved context are cached for 15 minutes.
7. Voice input on the knowledge page uses browser speech recognition.
8. ElevenLabs knowledge-answer speech is opt-in via **Listen**.
9. Active session persistence is throttled by `KNOWLEDGE_PERSIST_INTERVAL_MS` (60 seconds by default), with forced saves at milestones.

## Important endpoints

| Method | Endpoint | Authorization |
|---|---|---|
| POST | `/api/auth/signup` | public |
| POST | `/api/auth/login` | public |
| GET | `/api/auth/me` | cookie session |
| POST | `/api/room` | teacher only |
| POST | `/api/room/:code/join` | learner only |
| GET | `/api/room/:code/stream` | room owner/member |
| POST | `/api/room/:code/share-state` | owning teacher only |
| POST | `/api/vision` | owning teacher only |
| POST | `/api/room/:code/chat` | owner/member; sender role derived server-side |
| POST | `/api/knowledge/ask` | learner only |
| GET | `/api/knowledge/teacher` | teacher only |
| POST | `/api/voice/tts` | authenticated |

## Project layout

```text
server/
  index.js                 authenticated HTTP/SSE API
  lib/
    supabase.js            Supabase Auth/REST + HttpOnly-cookie sessions
    authz.js               teacher/learner room permissions
    knowledge.js           archive/chunk persistence + FTS retrieval/cache
    room.js                live room state, collaboration, curriculum, practice
    reasoning.js           Claude reasoning + grounded KB answers
    vision.js              Claude screen analysis
    voice.js               ElevenLabs TTS with browser fallback
web/
  index.html               sign-up/login + role-specific dashboard
  dashboard.js
  room.html / app.js       authenticated live teacher/learner room
  knowledge.html/js        learner KB chatbot + teacher session library
supabase/migrations/
  001_mentaur_auth_knowledge.sql
test/
  run.mjs
```

## Tests

```bash
npm test
```

The unit suite covers the original planner/work-map behavior plus account authorization boundaries and knowledge-chunk construction. The browser E2E script requires a running server plus two existing Supabase test accounts. Set `E2E_TEACHER_EMAIL`, `E2E_TEACHER_PASSWORD`, `E2E_LEARNER_EMAIL`, and `E2E_LEARNER_PASSWORD` before running `node test/e2e.mjs`.

## License

MIT — see `LICENSE`.
