import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getAnthropic, TEXT_MODEL } from "@/lib/anthropic";
import { loadSession, saveSession } from "@/lib/store";
import type { WorkMap } from "@/lib/types";

export const runtime = "nodejs";

const WORK_MAP_TOOL = {
  name: "emit_work_map",
  description: "Emit the structured Work Map for this session.",
  input_schema: {
    type: "object" as const,
    properties: {
      title: { type: "string" },
      steps: {
        type: "array",
        items: {
          type: "object",
          properties: {
            index: { type: "number" },
            title: { type: "string" },
            screenMomentLabel: { type: "string", description: "e.g. '03:12, invoice 4471, cost center field'" },
            screenMomentEventId: {
              type: ["string", "null"],
              description: "The matching event's id= value from the SCREEN EVENTS list, if one clearly matches.",
            },
            decision: { type: "string" },
            reason: { type: "string", description: "The reason, quoted in the expert's own words where possible." },
            reasonQuote: { type: "boolean", description: "true if `reason` is a direct quote from the expert" },
            guardrails: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  rule: { type: "string" },
                  stopCondition: { type: ["string", "null"] },
                },
                required: ["rule"],
              },
            },
          },
          required: ["index", "title", "screenMomentLabel", "decision", "reason", "reasonQuote", "guardrails"],
        },
      },
      teachBackSummary: { type: "string" },
      teachBackConfirmed: { type: "boolean" },
      openGaps: { type: "array", items: { type: "string" } },
    },
    required: ["title", "steps", "teachBackSummary", "teachBackConfirmed", "openGaps"],
  },
};

export async function POST(req: NextRequest) {
  const { sessionId } = (await req.json()) as { sessionId: string };
  if (!sessionId) {
    return NextResponse.json({ error: "sessionId is required" }, { status: 400 });
  }

  const session = await loadSession(sessionId);
  if (!session) {
    return NextResponse.json({ error: "session not found" }, { status: 404 });
  }

  const anthropic = getAnthropic();

  const eventsText = session.events
    .map((e) => `[id=${e.id} t=${(e.t / 1000).toFixed(1)}s] ${e.summary}`)
    .join("\n");
  const liveQAText = session.questions
    .map((q) => `Q (${q.type}): ${q.question}${q.answer ? `\nA: ${q.answer}` : ""}`)
    .join("\n\n");
  const liveTranscriptText = session.transcript
    .map((t) => `${t.role}: ${t.text}`)
    .join("\n");
  const debriefText = session.debriefTranscript
    .map((t) => `${t.role}: ${t.text}`)
    .join("\n");

  const userPrompt = `Build the Work Map for "${session.title}" with expert ${session.expertName}.

SCREEN EVENTS (chronological, from the vision pipeline):
${eventsText || "(none captured)"}

LIVE QUESTIONS LOGGED DURING CAPTURE:
${liveQAText || "(none)"}

FULL LIVE CONVERSATION TRANSCRIPT:
${liveTranscriptText || "(none)"}

DEBRIEF CONVERSATION TRANSCRIPT:
${debriefText || "(none)"}

Merge all of this into a Work Map: an ordered list of steps. Each step should reflect one meaningful
decision or action grounded in the screen events, with the reason in the expert's own words whenever the
transcript gives you one (set reasonQuote true only when it is a close paraphrase/quote of something they
actually said). Pull every guardrail you can find — limits, thresholds, exceptions, "stop and ask" moments —
and attach each to the step it belongs to. teachBackSummary should be the apprentice's own final teach-back
of the whole process (from the debrief transcript if present, otherwise synthesize one). teachBackConfirmed
is true only if the expert explicitly confirmed it in the debrief transcript. openGaps should list anything
still unclear or never resolved (e.g. unanswered questions, exceptions mentioned but not explained).
Call emit_work_map with the result.`;

  const msg = await anthropic.messages.create({
    model: TEXT_MODEL,
    max_tokens: 4000,
    tools: [WORK_MAP_TOOL],
    tool_choice: { type: "tool", name: "emit_work_map" },
    messages: [{ role: "user", content: userPrompt }],
  });

  const toolUse = msg.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    return NextResponse.json({ error: "model did not return a work map" }, { status: 502 });
  }

  const raw = toolUse.input as {
    title: string;
    steps: Array<{
      index: number;
      title: string;
      screenMomentLabel: string;
      screenMomentEventId?: string | null;
      decision: string;
      reason: string;
      reasonQuote: boolean;
      guardrails: Array<{ rule: string; stopCondition?: string | null }>;
    }>;
    teachBackSummary: string;
    teachBackConfirmed: boolean;
    openGaps: string[];
  };

  const workMap: WorkMap = {
    sessionId,
    title: raw.title,
    generatedAt: Date.now(),
    steps: raw.steps.map((s) => ({
      id: randomUUID(),
      index: s.index,
      title: s.title,
      screenMoment: {
        t: session.events.find((e) => e.id === s.screenMomentEventId)?.t ?? 0,
        label: s.screenMomentLabel,
        eventId: s.screenMomentEventId || undefined,
      },
      decision: s.decision,
      reason: s.reason,
      reasonQuote: s.reasonQuote,
      guardrails: s.guardrails.map((g) => ({
        id: randomUUID(),
        rule: g.rule,
        stopCondition: g.stopCondition || undefined,
      })),
    })),
    judgmentCallCount: raw.steps.length,
    guardrailCount: raw.steps.reduce((sum, s) => sum + s.guardrails.length, 0),
    teachBackSummary: raw.teachBackSummary,
    teachBackConfirmed: raw.teachBackConfirmed,
    openGaps: raw.openGaps,
  };

  session.workMap = workMap;
  session.phase = "mapped";
  await saveSession(session);

  return NextResponse.json({ workMap, session });
}
