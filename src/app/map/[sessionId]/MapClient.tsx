"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ConversationProvider, useConversation } from "@elevenlabs/react";
import type { CaptureSession, TranscriptTurn, WorkMapStep } from "@/lib/types";

export default function MapClient({ sessionId }: { sessionId: string }) {
  const [session, setSession] = useState<CaptureSession | null>(null);

  useEffect(() => {
    fetch(`/api/session/${sessionId}`)
      .then((r) => r.json())
      .then((d) => setSession(d.session));
  }, [sessionId]);

  if (!session) {
    return <main className="max-w-3xl mx-auto py-20 px-6 text-neutral-500">Loading session…</main>;
  }

  if (session.workMap) {
    return <WorkMapView session={session} />;
  }

  return (
    <ConversationProvider>
      <DebriefRunner session={session} onMapped={setSession} />
    </ConversationProvider>
  );
}

function DebriefRunner({
  session,
  onMapped,
}: {
  session: CaptureSession;
  onMapped: (s: CaptureSession) => void;
}) {
  const [transcript, setTranscript] = useState<TranscriptTurn[]>(session.debriefTranscript || []);
  const [building, setBuilding] = useState(false);
  const [teachBackDone, setTeachBackDone] = useState(false);
  const startedAtRef = useRef(0);
  const transcriptRef = useRef(transcript);

  async function finishAndBuildMap(finalTranscript: TranscriptTurn[]) {
    setBuilding(true);
    await fetch(`/api/session/${session.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ debriefTranscript: finalTranscript }),
    });
    const res = await fetch("/api/workmap/build", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: session.id }),
    });
    const data = await res.json();
    setBuilding(false);
    if (res.ok) onMapped(data.session);
  }

  const conversation = useConversation({
    clientTools: {
      log_question: () => "logged",
      mark_teachback_done: () => {
        setTeachBackDone(true);
        void finishAndBuildMap(transcriptRef.current);
        return "ok";
      },
    },
    onMessage: (m) => {
      if (!m.message) return;
      setTranscript((t) => {
        const next: TranscriptTurn[] = [
          ...t,
          {
            id: crypto.randomUUID(),
            t: Date.now() - startedAtRef.current,
            role: (m.source === "user" ? "expert" : "agent") as TranscriptTurn["role"],
            text: m.message,
          },
        ];
        transcriptRef.current = next;
        return next;
      });
    },
  });

  async function startDebrief() {
    startedAtRef.current = Date.now();
    await navigator.mediaDevices.getUserMedia({ audio: true });
    const res = await fetch("/api/elevenlabs/signed-url?role=interviewer");
    const data = await res.json();
    if (!res.ok) {
      alert(data.error || "Could not connect to the ElevenLabs agent.");
      return;
    }
    await conversation.startSession({ signedUrl: data.signedUrl });

    const eventsSummary = session.events.map((e) => `- ${e.summary}`).join("\n") || "(no events captured)";
    const questionsSummary =
      session.questions.map((q) => `- (${q.type}) ${q.question}`).join("\n") || "(none)";

    conversation.sendContextualUpdate(
      `DEBRIEF MODE START. The task is finished. Here is what the vision pipeline logged during the live session:\n${eventsSummary}\n\nQuestions already asked live:\n${questionsSummary}\n\nBegin debrief mode now: ask about gaps and unclear cases, then deliver the teach-back and call mark_teachback_done.`
    );
  }

  return (
    <main className="max-w-2xl mx-auto py-16 px-6">
      <h1 className="text-xl font-semibold mb-1">Module 2 — Debrief</h1>
      <p className="text-sm text-neutral-500 mb-8">{session.title} · {session.expertName}</p>

      {conversation.status !== "connected" ? (
        <button
          onClick={startDebrief}
          className="px-4 py-2 rounded bg-sky-700 hover:bg-sky-600 text-sm"
        >
          Start spoken debrief
        </button>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <span className="text-xs px-2 py-1 rounded bg-emerald-800 text-emerald-100">
              connected
            </span>
            <span className="text-xs px-2 py-1 rounded bg-neutral-800 text-neutral-300">
              {conversation.isSpeaking ? "speaking…" : "listening"}
            </span>
          </div>
          <div className="border border-neutral-800 rounded-lg p-3 h-80 overflow-y-auto space-y-2 text-sm">
            {transcript.map((t) => (
              <div key={t.id}>
                <span className={t.role === "agent" ? "text-sky-300" : "text-neutral-200"}>
                  {t.role === "agent" ? "Apprentice: " : `${session.expertName}: `}
                  {t.text}
                </span>
              </div>
            ))}
          </div>
          {building && (
            <p className="text-sm text-neutral-500">Building the Work Map from this session…</p>
          )}
          {!teachBackDone && (
            <p className="text-xs text-neutral-600">
              Waiting for the teach-back to finish — the apprentice will confirm the process with{" "}
              {session.expertName} and then the Work Map builds automatically.
            </p>
          )}
        </div>
      )}
    </main>
  );
}

function WorkMapView({ session }: { session: CaptureSession }) {
  const wm = session.workMap!;
  const [selected, setSelected] = useState<WorkMapStep | null>(wm.steps[0] || null);

  return (
    <main className="max-w-6xl mx-auto py-8 px-6">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold">{wm.title}</h1>
          <p className="text-sm text-neutral-500">
            {session.expertName} · {wm.judgmentCallCount} judgment calls · {wm.guardrailCount}{" "}
            guardrails ·{" "}
            <span className={wm.teachBackConfirmed ? "text-emerald-400" : "text-amber-400"}>
              teach-back {wm.teachBackConfirmed ? "confirmed" : "unconfirmed"}
            </span>
          </p>
        </div>
        <Link
          href={`/teach/new?source=${session.id}`}
          className="text-xs px-3 py-1.5 rounded bg-sky-700 hover:bg-sky-600"
        >
          Start Teach session →
        </Link>
      </div>

      <div className="grid grid-cols-5 gap-6">
        <div className="col-span-2 border border-neutral-800 rounded-lg divide-y divide-neutral-800 max-h-[70vh] overflow-y-auto">
          {wm.steps.map((s) => (
            <button
              key={s.id}
              onClick={() => setSelected(s)}
              className={`w-full text-left px-4 py-3 hover:bg-neutral-900 ${
                selected?.id === s.id ? "bg-neutral-900" : ""
              }`}
            >
              <div className="text-xs text-neutral-500">Step {s.index}</div>
              <div className="text-sm text-neutral-100">{s.title}</div>
              {s.guardrails.length > 0 && (
                <div className="mt-1 text-[10px] text-amber-400">
                  {s.guardrails.length} guardrail{s.guardrails.length > 1 ? "s" : ""}
                </div>
              )}
            </button>
          ))}
        </div>

        <div className="col-span-3">
          {selected && (
            <div className="border border-neutral-800 rounded-lg p-5">
              <div className="text-xs text-neutral-500 mb-1">
                Step {selected.index} of {wm.steps.length} · {selected.screenMoment.label}
              </div>
              <h2 className="text-lg font-semibold mb-4">{selected.title}</h2>

              <div className="mb-4">
                <div className="text-xs uppercase tracking-wide text-neutral-500 mb-1">Decision</div>
                <p className="text-sm">{selected.decision}</p>
              </div>

              <div className="mb-4">
                <div className="text-xs uppercase tracking-wide text-neutral-500 mb-1">Reason</div>
                <p className="text-sm italic text-neutral-300">
                  {selected.reasonQuote ? `"${selected.reason}"` : selected.reason}
                </p>
              </div>

              {selected.guardrails.length > 0 && (
                <div>
                  <div className="text-xs uppercase tracking-wide text-neutral-500 mb-1.5">
                    Guardrails
                  </div>
                  <ul className="space-y-2">
                    {selected.guardrails.map((g) => (
                      <li
                        key={g.id}
                        className="border border-amber-900 bg-amber-950/40 rounded px-3 py-2 text-sm"
                      >
                        <div>{g.rule}</div>
                        {g.stopCondition && (
                          <div className="text-amber-400 text-xs mt-1">⚠ {g.stopCondition}</div>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          <div className="mt-6 border border-neutral-800 rounded-lg p-5">
            <div className="text-xs uppercase tracking-wide text-neutral-500 mb-1.5">
              Teach-back summary
            </div>
            <p className="text-sm text-neutral-300">{wm.teachBackSummary}</p>
          </div>

          {wm.openGaps.length > 0 && (
            <div className="mt-6 border border-neutral-800 rounded-lg p-5">
              <div className="text-xs uppercase tracking-wide text-neutral-500 mb-1.5">Open gaps</div>
              <ul className="list-disc list-inside text-sm text-neutral-400 space-y-1">
                {wm.openGaps.map((g, i) => (
                  <li key={i}>{g}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
