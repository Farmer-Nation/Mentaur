/**
 * Provisions the two ElevenAgents used by the AI Apprentice MVP:
 *   1. "AI Apprentice - Interviewer" — Module 1 (Capture) and Module 2 (Debrief,
 *      reached via a conversationConfigOverride that appends debrief instructions).
 *   2. "AI Apprentice - Tutor" — Module 3 (Teach).
 *
 * Run with:  npm run create-agents
 * Requires ELEVENLABS_API_KEY in .env.local. Writes the resulting agent ids
 * back into .env.local (ELEVENLABS_INTERVIEWER_AGENT_ID / ELEVENLABS_TUTOR_AGENT_ID).
 *
 * If ElevenLabs changes this REST shape, the dashboard UI (elevenlabs.io/app/agents)
 * covers the same ground: paste the system prompt below, add the client tools
 * listed, pick the TTS model "eleven_v3_conversational" for Expressive Mode,
 * then paste the resulting agent id into .env.local by hand.
 */
import { config as loadEnv } from "dotenv";
import { existsSync, readFileSync, writeFileSync } from "fs";
import path from "path";

loadEnv({ path: path.join(process.cwd(), ".env.local") });

const API_KEY = process.env.ELEVENLABS_API_KEY;
const LLM = process.env.ELEVENLABS_LLM || "claude-sonnet-4-5";

if (!API_KEY) {
  console.error("ELEVENLABS_API_KEY is not set. Add it to .env.local first.");
  process.exit(1);
}

const LOG_QUESTION_TOOL = {
  type: "client",
  name: "log_question",
  description:
    "Call this every time you ask the expert a substantive spoken question (not small talk). " +
    "Used to track coverage of why/guardrail/exception questions for the session.",
  parameters: {
    type: "object",
    properties: {
      type: {
        type: "string",
        enum: ["why", "guardrail", "exception", "general"],
        description:
          "'why' = asks the reason for a decision. 'guardrail' = asks about a limit, threshold, or when to stop and ask someone. 'exception' = asks about an edge case or rule you are unsure about.",
      },
      question: { type: "string", description: "The question you just asked, verbatim." },
    },
    required: ["type", "question"],
  },
  expects_response: false,
  response_timeout_secs: 10,
};

const MARK_TEACHBACK_TOOL = {
  type: "client",
  name: "mark_teachback_done",
  description:
    "Call this once, at the very end of the debrief, after you have explained the whole process back in your own words and the expert has confirmed or corrected it.",
  parameters: {
    type: "object",
    properties: {
      summary: { type: "string", description: "Your final teach-back summary of the process." },
      confirmed: { type: "boolean", description: "Whether the expert confirmed it was accurate." },
    },
    required: ["summary", "confirmed"],
  },
  expects_response: false,
  response_timeout_secs: 10,
};

const FLAG_GUARDRAIL_RISK_TOOL = {
  type: "client",
  name: "flag_guardrail_risk",
  description:
    "Call this the moment you notice the new hire is about to do something that breaks a guardrail from the Work Map (e.g. wrong cost center code, skipping a required second approval). Call it BEFORE they save/submit, not after.",
  parameters: {
    type: "object",
    properties: {
      stepHint: { type: "string", description: "Which Work Map step this relates to (title or short description)." },
      message: { type: "string", description: "Short message explaining what looks wrong, for the UI to display." },
    },
    required: ["stepHint", "message"],
  },
  expects_response: false,
  response_timeout_secs: 10,
};

const REPLAY_SCREEN_MOMENT_TOOL = {
  type: "client",
  name: "replay_screen_moment",
  description:
    "Call this to show the new hire the expert's own screen moment for a given step, e.g. when explaining why the expert made a decision.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Short description of which expert moment to replay, e.g. 'coding the capex invoice'." },
    },
    required: ["query"],
  },
  expects_response: true,
  response_timeout_secs: 10,
};

const MARK_MASTERY_TOOL = {
  type: "client",
  name: "mark_mastery",
  description:
    "Call this once per topic/guardrail covered when the case is finished, to record whether the new hire has mastered it or should practice it more.",
  parameters: {
    type: "object",
    properties: {
      topic: { type: "string" },
      mastered: { type: "boolean" },
    },
    required: ["topic", "mastered"],
  },
  expects_response: false,
  response_timeout_secs: 10,
};

const INTERVIEWER_SYSTEM_PROMPT = `You are the AI Apprentice: a calm, curious, patient colleague who is learning a real
desk-work process by watching an expert do it, the way a new hire would shadow someone over their shoulder.

You do not see raw video. Instead, a vision pipeline watches the shared screen and sends you short factual
events as contextual updates, e.g. "Invoice 4471 cost center changed from 4711 to 0400", or "pause detected
after invoice 4471 edit, no new question asked yet". Treat these as ground truth about what just happened.

LIVE MODE RULES (while the expert is working):
- Stay completely silent while there is no "pause detected" signal — the expert may be typing, reading, or
  talking through something, and interrupting mid-action is the single worst thing you can do.
- When you DO get a "pause detected" signal, decide: is there something here worth asking about? If the
  screen event was routine and self-explanatory, stay quiet and wait for the next one.
- When you ask, ask ONE short, specific, spoken-sounding question about the thing that just happened on
  screen — never a generic question like "how's it going?" or something the screen already answered.
  Good: "You moved that one to capex — what made you do that?" Bad: "Can you walk me through this invoice?"
- Over a real task you must ask at least three live questions, spaced out naturally, and at least one of
  them must be about a guardrail: a limit, a threshold, an exception, or the moment to stop and ask someone
  else. Vary between asking "why" (the reason for a decision), guardrails (limits/exceptions), and "what would
  you never do" style questions.
- Every time you ask one of these substantive questions, call the log_question client tool immediately with
  the type and the exact question, so the system can track coverage.
- Keep your spoken questions short — one sentence, like a real colleague, never a form or checklist read aloud.

DEBRIEF MODE (only once you are told the task is complete and debrief mode has started):
- Ask about the exceptions you noticed but never got explained, the rules you are still unsure about, and
  cases you have not seen covered. Keep asking — calling log_question each time — until you believe you
  could explain the whole process to a new hire.
- Then explain the ENTIRE process back to the expert, in your own words, in under a minute: the steps, the
  decisions, the reasons, and the guardrails. End with something like "Did I get that right?" and wait for
  the expert to confirm or correct a detail.
- Once you have delivered that teach-back and the expert has responded, call mark_teachback_done with your
  summary and whether it was confirmed.

You are warm and genuinely curious, not clinical. Sound like a thoughtful colleague, not a survey.`;

const TUTOR_SYSTEM_PROMPT = `You are the AI Apprentice, now acting as a voice tutor teaching a new hire a process that
you learned by watching an expert and building a Work Map (steps, decisions, the expert's own reasoning, and
guardrails). The Work Map for this session will be provided to you as additional context when the conversation
starts — treat it as ground truth about how the expert does this job and what they said.

As the new hire works a live case on their own shared screen, you receive the same kind of short factual
screen-change events as contextual updates that the interviewer used during capture.

RULES:
- Narrate like a patient colleague, not a manual. When the new hire reaches a step from the Work Map, briefly
  explain it the way the expert did, in the expert's own words where you have a quote.
- Before a step with a judgment call, ask the new hire to predict what they'd do and why, instead of just
  telling them — let them try first.
- If a screen event suggests the new hire is about to break a guardrail from the Work Map (e.g. the wrong
  cost-center code, skipping a required second approval), you MUST call flag_guardrail_risk BEFORE they save
  or submit, and ask a short Socratic question like "[Expert] would stop here — why do you think?" rather than
  immediately stating the rule.
- If it would help to show the new hire the expert's own screen moment for a step, call replay_screen_moment
  with a short description of which moment.
- At the end of the case, call mark_mastery once per guardrail/topic covered, marking it mastered or not, so
  a summary of what to practice next can be shown.

Be encouraging but precise — your job is to make sure the new hire could handle the next case alone.`;

interface CreateAgentResponse {
  agent_id: string;
}

async function createAgent(opts: {
  name: string;
  prompt: string;
  firstMessage: string;
  tools: unknown[];
}): Promise<string> {
  const body = {
    name: opts.name,
    conversation_config: {
      agent: {
        prompt: {
          prompt: opts.prompt,
          llm: LLM,
          temperature: 0.4,
          tools: opts.tools,
        },
        first_message: opts.firstMessage,
        language: "en",
      },
      tts: {
        model_id: "eleven_v3_conversational", // enables Expressive Mode
      },
      asr: {
        provider: "scribe_realtime",
        quality: "high",
      },
      turn: {
        turn_timeout: 10,
      },
    },
  };

  const res = await fetch("https://api.elevenlabs.io/v1/convai/agents/create", {
    method: "POST",
    headers: {
      "xi-api-key": API_KEY as string,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to create agent "${opts.name}" (${res.status}): ${text}`);
  }

  const data = (await res.json()) as CreateAgentResponse;
  return data.agent_id;
}

function upsertEnvVar(envPath: string, key: string, value: string) {
  let content = existsSync(envPath) ? readFileSync(envPath, "utf-8") : "";
  const line = `${key}=${value}`;
  if (new RegExp(`^${key}=.*$`, "m").test(content)) {
    content = content.replace(new RegExp(`^${key}=.*$`, "m"), line);
  } else {
    content += (content.endsWith("\n") || content === "" ? "" : "\n") + line + "\n";
  }
  writeFileSync(envPath, content, "utf-8");
}

async function main() {
  console.log(`Creating agents with LLM="${LLM}" (set ELEVENLABS_LLM in .env.local to change)...`);

  const interviewerId = await createAgent({
    name: "AI Apprentice - Interviewer",
    prompt: INTERVIEWER_SYSTEM_PROMPT,
    firstMessage:
      "Hi — I'll just listen while you work. Go ahead and start, I'll ask if something's worth asking about.",
    tools: [LOG_QUESTION_TOOL, MARK_TEACHBACK_TOOL],
  });
  console.log(`Created interviewer agent: ${interviewerId}`);

  const tutorId = await createAgent({
    name: "AI Apprentice - Tutor",
    prompt: TUTOR_SYSTEM_PROMPT,
    firstMessage: "Ready when you are — open the first case and I'll walk through it with you.",
    tools: [FLAG_GUARDRAIL_RISK_TOOL, REPLAY_SCREEN_MOMENT_TOOL, MARK_MASTERY_TOOL],
  });
  console.log(`Created tutor agent: ${tutorId}`);

  const envPath = path.join(process.cwd(), ".env.local");
  upsertEnvVar(envPath, "ELEVENLABS_INTERVIEWER_AGENT_ID", interviewerId);
  upsertEnvVar(envPath, "ELEVENLABS_TUTOR_AGENT_ID", tutorId);
  console.log(`\nWrote agent ids to ${envPath}. You're ready to run "npm run dev".`);
}

main().catch((err) => {
  console.error(err);
  console.error(
    "\nIf this failed due to an API shape change, create the two agents manually at " +
      "elevenlabs.io/app/agents using the prompts/tools in scripts/create-agents.ts, then set " +
      "ELEVENLABS_INTERVIEWER_AGENT_ID and ELEVENLABS_TUTOR_AGENT_ID in .env.local by hand."
  );
  process.exit(1);
});
