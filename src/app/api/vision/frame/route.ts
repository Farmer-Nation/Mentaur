import { NextRequest, NextResponse } from "next/server";
import { getAnthropic, VISION_MODEL } from "@/lib/anthropic";
import { redactEventSummary } from "@/lib/redact";

export const runtime = "nodejs";

interface FrameRequestBody {
  currentFrame: string; // base64 jpeg, no data: prefix
  previousFrame?: string | null;
  lastEventSummary?: string | null;
}

interface DiffResult {
  changed: boolean;
  summary: string;
  field: string | null;
  from: string | null;
  to: string | null;
}

const SYSTEM_PROMPT = `You are the vision-diffing module of "The AI Apprentice", watching someone's work screen
(an invoicing / ERP-style app) one or two seconds at a time so a voice agent can understand what they just did,
without ever watching raw video.

You receive the PREVIOUS screen frame and the CURRENT screen frame, roughly 1-2 seconds apart.
Decide if a meaningful BUSINESS action happened between them: a field value changed, a record was opened,
a decision was made (approved / held / re-coded / flagged), a status changed. Ignore cursor movement,
blinking caret, hover states, or scrolling that didn't open a new record or change a value.

Reply with ONLY strict JSON, no prose, no markdown fence:
{"changed": boolean, "summary": string, "field": string|null, "from": string|null, "to": string|null}

"summary" should be a short factual past-tense sentence a workflow log would show, e.g.
"Invoice 4471 cost center changed from 4711 to 0400" or "Invoice 4832 opened" or "Invoice 4590 marked on hold".
If changed is false, summary can briefly say what is still happening (e.g. "still reviewing invoice 4471").
Never invent values you cannot actually read on screen.`;

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as FrameRequestBody;
    if (!body.currentFrame) {
      return NextResponse.json({ error: "currentFrame is required" }, { status: 400 });
    }

    const anthropic = getAnthropic();

    const contentBlocks: Array<
      | { type: "text"; text: string }
      | { type: "image"; source: { type: "base64"; media_type: "image/jpeg"; data: string } }
    > = [];

    if (body.previousFrame) {
      contentBlocks.push({ type: "text", text: "PREVIOUS frame:" });
      contentBlocks.push({
        type: "image",
        source: { type: "base64", media_type: "image/jpeg", data: body.previousFrame },
      });
    } else {
      contentBlocks.push({ type: "text", text: "This is the FIRST frame of the session (no previous frame)." });
    }

    contentBlocks.push({ type: "text", text: "CURRENT frame:" });
    contentBlocks.push({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: body.currentFrame },
    });

    if (body.lastEventSummary) {
      contentBlocks.push({
        type: "text",
        text: `For context, the last logged event was: "${body.lastEventSummary}"`,
      });
    }

    const msg = await anthropic.messages.create({
      model: VISION_MODEL,
      max_tokens: 300,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: contentBlocks }],
    });

    const textBlock = msg.content.find((b) => b.type === "text");
    const raw = textBlock && "text" in textBlock ? textBlock.text : "{}";

    let parsed: DiffResult;
    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
    } catch {
      parsed = { changed: false, summary: "", field: null, from: null, to: null };
    }

    parsed.summary = redactEventSummary(parsed.summary || "");

    return NextResponse.json(parsed);
  } catch (err) {
    console.error("vision/frame error", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
