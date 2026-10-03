import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { loadSession, saveTeachSession } from "@/lib/store";
import type { TeachSession } from "@/lib/types";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const body = (await req.json()) as { sourceSessionId: string; newHireName?: string };
  const source = await loadSession(body.sourceSessionId);
  if (!source || !source.workMap) {
    return NextResponse.json(
      { error: "source session has no Work Map yet — build it first" },
      { status: 400 }
    );
  }

  const teachSession: TeachSession = {
    id: randomUUID(),
    sourceSessionId: body.sourceSessionId,
    newHireName: body.newHireName || "New hire",
    createdAt: Date.now(),
    events: [],
    transcript: [],
    evaluations: [],
    mastered: [],
    practiceNext: [],
  };

  await saveTeachSession(teachSession);
  return NextResponse.json({ teachSession, workMap: source.workMap, sourceEvents: source.events });
}
