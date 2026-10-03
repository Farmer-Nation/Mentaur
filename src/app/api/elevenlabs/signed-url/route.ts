import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

// Mints a short-lived signed WebSocket URL server-side so the ElevenLabs API
// key never reaches the browser. `role` picks which agent to connect to:
// "interviewer" is used for both Module 1 (capture) and Module 2 (debrief,
// via a conversationConfigOverride on the client), "tutor" is Module 3.
export async function GET(req: NextRequest) {
  const role = req.nextUrl.searchParams.get("role") || "interviewer";

  const agentId =
    role === "tutor"
      ? process.env.ELEVENLABS_TUTOR_AGENT_ID
      : process.env.ELEVENLABS_INTERVIEWER_AGENT_ID;

  const apiKey = process.env.ELEVENLABS_API_KEY;

  if (!apiKey) {
    return NextResponse.json(
      { error: "ELEVENLABS_API_KEY is not set. Add it to .env.local." },
      { status: 500 }
    );
  }
  if (!agentId) {
    return NextResponse.json(
      {
        error: `No agent id configured for role "${role}". Run "npm run create-agents" first, or set ELEVENLABS_INTERVIEWER_AGENT_ID / ELEVENLABS_TUTOR_AGENT_ID in .env.local.`,
      },
      { status: 500 }
    );
  }

  const url = `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(
    agentId
  )}`;

  const res = await fetch(url, {
    headers: { "xi-api-key": apiKey },
  });

  if (!res.ok) {
    const text = await res.text();
    return NextResponse.json(
      { error: `ElevenLabs signed-url request failed (${res.status}): ${text}` },
      { status: 502 }
    );
  }

  const data = (await res.json()) as { signed_url: string };
  return NextResponse.json({ signedUrl: data.signed_url, agentId });
}
