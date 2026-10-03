import { NextRequest, NextResponse } from "next/server";
import { loadTeachSession, saveTeachSession, loadSession } from "@/lib/store";
import type { TeachSession } from "@/lib/types";

export const runtime = "nodejs";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const teachSession = await loadTeachSession(id);
  if (!teachSession) {
    return NextResponse.json({ error: "teach session not found" }, { status: 404 });
  }
  const source = await loadSession(teachSession.sourceSessionId);
  return NextResponse.json({
    teachSession,
    workMap: source?.workMap,
    sourceEvents: source?.events || [],
  });
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const existing = await loadTeachSession(id);
  if (!existing) {
    return NextResponse.json({ error: "teach session not found" }, { status: 404 });
  }
  const update = (await req.json()) as Partial<TeachSession>;
  const merged: TeachSession = { ...existing, ...update, id };
  await saveTeachSession(merged);
  return NextResponse.json({ teachSession: merged });
}
