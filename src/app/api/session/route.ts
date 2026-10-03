import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { listSessions, saveSession } from "@/lib/store";
import type { CaptureSession } from "@/lib/types";

export const runtime = "nodejs";

export async function GET() {
  const sessions = await listSessions();
  return NextResponse.json({ sessions });
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as { title?: string; expertName?: string };

  const session: CaptureSession = {
    id: randomUUID(),
    title: body.title || "Untitled workflow",
    expertName: body.expertName || "Expert",
    createdAt: Date.now(),
    phase: "capture",
    events: [],
    questions: [],
    transcript: [],
    debriefTranscript: [],
    offTheRecordRanges: [],
  };

  await saveSession(session);
  return NextResponse.json({ session });
}
