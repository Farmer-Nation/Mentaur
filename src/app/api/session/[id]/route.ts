import { NextRequest, NextResponse } from "next/server";
import { loadSession, saveSession } from "@/lib/store";
import type { CaptureSession } from "@/lib/types";

export const runtime = "nodejs";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const session = await loadSession(id);
  if (!session) {
    return NextResponse.json({ error: "session not found" }, { status: 404 });
  }
  return NextResponse.json({ session });
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const existing = await loadSession(id);
  if (!existing) {
    return NextResponse.json({ error: "session not found" }, { status: 404 });
  }
  const update = (await req.json()) as Partial<CaptureSession>;
  const merged: CaptureSession = { ...existing, ...update, id };
  await saveSession(merged);
  return NextResponse.json({ session: merged });
}
