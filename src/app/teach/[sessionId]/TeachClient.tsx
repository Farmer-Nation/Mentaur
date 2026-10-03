"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ConversationProvider, useConversation } from "@elevenlabs/react";
import { useScreenCapture } from "@/lib/useScreenCapture";
import type {
  ScreenEvent,
  TeachEvaluation,
  TeachSession,
  TranscriptTurn,
  WorkMap,
  WorkMapStep,
} from "@/lib/types";

function fmtT(ms: number) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${rem.toString().padStart(2, "0")}`;
}

function matchStep(query: string, steps: WorkMapStep[]): WorkMapStep | null {
  const q = query.toLowerCase();
  let best: WorkMapStep | null = null;
  let bestScore = 0;
  for (const s of steps) {
    const haystack = `${s.title} ${s.decision} ${s.reason} ${s.guardrails
      .map((g) => g.rule)
      .join(" ")}`.toLowerCase();
    const words = q.split(/\W+/).filter((w) => w.length > 3);
    const score = words.reduce((acc, w) => acc + (haystack.includes(w) ? 1 : 0), 0);
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return best;
}

export default function TeachClient({ teachSessionId }: { teachSessionId: string }) {
  const [teachSession, setTeachSession] = useState<TeachSession | null>(null);
  const [workMap, setWorkMap] = useState<WorkMap | null>(null);
  const [sourceEvents, setSourceEvents] = useState<ScreenEvent[]>([]);

  useEffect(() => {
    fetch(`/api/teach/${teachSessionId}`)
      .then((r) => r.json())
      .then((d) => {
        setTeachSession(d.teachSession);
        setWorkMap(d.workMap || null);
        setSourceEvents(d.sourceEvents || []);
      });
  }, [teachSessionId]);

  if (!teachSession || !workMap) {
    return <main className="max-w-3xl mx-auto py-20 px-6 text-neutral-500">Loading…</main>;
  }

  return (
    <ConversationProvider>
      <TeachInner teachSession={teachSession} workMap={workMap} sourceEvents={sourceEvents} />
    </ConversationProvider>
  );
}

function TeachInner({
  teachSession,
  workMap,
  sourceEvents,
}: {
  teachSession: TeachSession;
  workMap: WorkMap;
  sourceEvents: ScreenEvent[];
}) {
  const [events, setEvents] = useState<ScreenEvent[]>([]);
  const [transcript, setTranscript] = useState<TranscriptTurn[]>([]);
  const [alerts, setAlerts] = useState<{ id: string; t: number; stepHint: string; message: string }[]>(
    []
  );
  const [evaluations, setEvaluations] = useState<TeachEvaluation[]>([]);
  const [mastery, setMastery] = useState<{ topic: string; mastered: boolean }[]>([]);
  const [replay, setReplay] = useState<{ step: WorkMapStep; thumbnail?: string } | null>(null);
  const [completed, setCompleted] = useState(false);
  const [saving, setSaving] = useState(false);

  const startedAtRef = useRef(0);

  const conversation = useConversation({
    clientTools: {
      flag_guardrail_risk: (params: { stepHint: string; message: string }) => {
        const alert = {
          id: crypto.randomUUID(),
          t: Date.now() - startedAtRef.current,
          stepHint: params.stepHint,
          message: params.message,
        };
        setAlerts((a) => [...a, alert]);
        const step = matchStep(params.stepHint, workMap.steps);
        setEvaluations((e) => [
          ...e,
          {
            id: crypto.randomUUID(),
            t: alert.t,
            stepId: step?.id,
            correct: false,
            note: params.message,
          },
        ]);
        return "flagged";
      },
      replay_screen_moment: (params: { query: string }) => {
        const step = matchStep(params.query, workMap.steps);
        if (!step) return "No matching expert moment found for that.";
        const sourceEvent = sourceEvents.find((e) => e.id === step.screenMoment.eventId);
        setReplay({ step, thumbnail: sourceEvent?.frameThumbnail });
        return `Replaying the expert's screen moment: ${step.screenMoment.label}. ${
          step.reasonQuote ? `They said: "${step.reason}"` : step.reason
        }`;
      },
      mark_mastery: (params: { topic: string; mastered: boolean }) => {
        setMastery((m) => {
          const existing = m.find((x) => x.topic === params.topic);
          if (existing) {
            return m.map((x) => (x.topic === params.topic ? { ...x, mastered: params.mastered } : x));
          }
          return [...m, { topic: params.topic, mastered: params.mastered }];
        });
        return "recorded";
      },
    },
    onMessage: (m) => {
      if (!m.message) return;
      setTranscript((t) => [
        ...t,
        {
          id: crypto.randomUUID(),
          t: Date.now() - startedAtRef.current,
          role: (m.source === "user" ? "new_hire" : "agent") as TranscriptTurn["role"],
          text: m.message,
        },
      ]);
    },
  });

  const handleEvent = useCallback(
    (event: ScreenEvent) => {
      setEvents((e) => [...e, event]);
      if (conversation.status === "connected") {
        conversation.sendContextualUpdate(`SCREEN EVENT: ${event.summary}`);
      }
    },
    [conversation]
  );

  const handlePause = useCallback(() => {
    if (conversation.status === "connected") {
      conversation.sendContextualUpdate(
        "PAUSE DETECTED: no visual change on screen for a few seconds."
      );
    }
  }, [conversation]);

  const {
    videoRef,
    isSharing,
    error: captureError,
    start: startCaptureStream,
    stop: stopCaptureStream,
  } = useScreenCapture({ pauseMs: 3000, onEvent: handleEvent, onPause: handlePause });

  async function startTeach() {
    startedAtRef.current = Date.now();
    await startCaptureStream();
    await navigator.mediaDevices.getUserMedia({ audio: true });
    const res = await fetch("/api/elevenlabs/signed-url?role=tutor");
    const data = await res.json();
    if (!res.ok) {
      alert(data.error || "Could not connect to the ElevenLabs tutor agent.");
      return;
    }
    await conversation.startSession({ signedUrl: data.signedUrl });

    const stepsSummary = workMap.steps
      .map(
        (s) =>
          `Step ${s.index}: ${s.title}\n  Decision: ${s.decision}\n  Reason: ${
            s.reasonQuote ? `"${s.reason}"` : s.reason
          }\n  Guardrails: ${s.guardrails.map((g) => `${g.rule}${g.stopCondition ? ` (${g.stopCondition})` : ""}`).join("; ") || "none"}`
      )
      .join("\n\n");

    conversation.sendContextualUpdate(
      `WORK MAP CONTEXT for this case (learned from the expert):\n\n${stepsSummary}\n\nThe new hire is now working a fresh case on their own screen. Watch the screen events, teach each step the way the expert did, ask them to predict decisions, and call flag_guardrail_risk the moment you see them heading toward breaking a guardrail — before they save or submit.`
    );
  }

  async function endAndSummarize() {
    setSaving(true);
    conversation.endSession?.();
    stopCaptureStream();
    const mastered = mastery.filter((m) => m.mastered).map((m) => m.topic);
    const practiceNext = mastery.filter((m) => !m.mastered).map((m) => m.topic);
    await fetch(`/api/teach/${teachSession.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        events,
        transcript,
        evaluations,
        mastered,
        practiceNext,
        completedAt: Date.now(),
      }),
    });
    setSaving(false);
    setCompleted(true);
  }

  if (completed) {
    const mastered = mastery.filter((m) => m.mastered).map((m) => m.topic);
    const practiceNext = mastery.filter((m) => !m.mastered).map((m) => m.topic);
    return (
      <main className="max-w-2xl mx-auto py-16 px-6">
        <h1 className="text-xl font-semibold mb-1">Session complete</h1>
        <p className="text-sm text-neutral-500 mb-8">{teachSession.newHireName} · {workMap.title}</p>

        <div className="border border-neutral-800 rounded-lg p-5 mb-5">
          <div className="text-xs uppercase tracking-wide text-neutral-500 mb-2">
            Guardrails caught live ({evaluations.length})
          </div>
          {evaluations.length === 0 ? (
            <p className="text-sm text-neutral-500">No guardrail risks were flagged this session.</p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {evaluations.map((e) => (
                <li key={e.id} className="text-amber-300">
                  [{fmtT(e.t)}] {e.note}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="grid grid-cols-2 gap-5">
          <div className="border border-neutral-800 rounded-lg p-5">
            <div className="text-xs uppercase tracking-wide text-emerald-500 mb-2">Mastered</div>
            {mastered.length === 0 ? (
              <p className="text-sm text-neutral-600">Nothing marked yet.</p>
            ) : (
              <ul className="text-sm space-y-1 text-neutral-300">
                {mastered.map((t) => (
                  <li key={t}>✓ {t}</li>
                ))}
              </ul>
            )}
          </div>
          <div className="border border-neutral-800 rounded-lg p-5">
            <div className="text-xs uppercase tracking-wide text-amber-500 mb-2">Practice next</div>
            {practiceNext.length === 0 ? (
              <p className="text-sm text-neutral-600">Nothing flagged for practice.</p>
            ) : (
              <ul className="text-sm space-y-1 text-neutral-300">
                {practiceNext.map((t) => (
                  <li key={t}>→ {t}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="max-w-6xl mx-auto py-8 px-6">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold">{workMap.title}</h1>
          <p className="text-sm text-neutral-500">New hire: {teachSession.newHireName}</p>
        </div>
        <a
          href="/sandbox?set=b"
          target="_blank"
          rel="noreferrer"
          className="text-xs px-3 py-1.5 rounded border border-neutral-700 hover:bg-neutral-900"
        >
          Open sandbox ERP (new case) ↗
        </a>
      </div>

      {!isSharing ? (
        <div className="border border-neutral-800 rounded-lg p-6 mb-6">
          <p className="text-sm text-neutral-400 mb-4">
            Open the sandbox ERP (button above) — it loads a fresh case the expert never showed.
            Click &quot;Start teach session&quot;, share that tab, and work the case while the tutor
            watches.
          </p>
          <button onClick={startTeach} className="px-4 py-2 rounded bg-sky-700 hover:bg-sky-600 text-sm">
            Start teach session
          </button>
          {captureError && <p className="text-sm text-red-400 mt-3">{captureError}</p>}
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-6">
          <div className="col-span-2 space-y-4">
            <div className="rounded-lg overflow-hidden border border-neutral-800 bg-black">
              <video ref={videoRef} muted className="w-full aspect-video object-contain" />
            </div>

            {alerts.length > 0 && (
              <div className="border border-amber-700 bg-amber-950/50 rounded-lg p-3">
                <div className="text-xs uppercase tracking-wide text-amber-400 mb-1">
                  Guardrail risk flagged
                </div>
                <p className="text-sm text-amber-100">{alerts[alerts.length - 1].message}</p>
              </div>
            )}

            {replay && (
              <div className="border border-sky-800 bg-sky-950/40 rounded-lg p-3 flex gap-3">
                {replay.thumbnail && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={`data:image/jpeg;base64,${replay.thumbnail}`}
                    alt="Expert screen moment"
                    className="w-32 rounded border border-sky-800"
                  />
                )}
                <div>
                  <div className="text-xs uppercase tracking-wide text-sky-400 mb-1">
                    Replaying expert moment
                  </div>
                  <p className="text-sm text-sky-100">{replay.step.screenMoment.label}</p>
                  <p className="text-xs text-sky-300 italic mt-1">
                    {replay.step.reasonQuote ? `"${replay.step.reason}"` : replay.step.reason}
                  </p>
                </div>
              </div>
            )}

            <div className="flex items-center gap-3">
              <span
                className={`text-xs px-2 py-1 rounded ${
                  conversation.status === "connected"
                    ? "bg-emerald-800 text-emerald-100"
                    : "bg-neutral-800 text-neutral-300"
                }`}
              >
                Tutor: {conversation.status}
              </span>
              <span className="text-xs px-2 py-1 rounded bg-neutral-800 text-neutral-300">
                {conversation.isSpeaking ? "speaking…" : "listening"}
              </span>
              <button
                onClick={endAndSummarize}
                disabled={saving}
                className="ml-auto text-xs px-3 py-1.5 rounded bg-sky-700 hover:bg-sky-600 disabled:opacity-50"
              >
                {saving ? "Saving…" : "End session & show summary"}
              </button>
            </div>

            <div>
              <h2 className="text-sm font-semibold text-neutral-300 mb-2">Live transcript</h2>
              <div className="border border-neutral-800 rounded-lg p-3 h-56 overflow-y-auto space-y-2 text-sm">
                {transcript.map((t) => (
                  <div key={t.id}>
                    <span className="text-neutral-500 mr-2">[{fmtT(t.t)}]</span>
                    <span className={t.role === "agent" ? "text-sky-300" : "text-neutral-200"}>
                      {t.role === "agent" ? "Tutor: " : `${teachSession.newHireName}: `}
                      {t.text}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="space-y-4">
            <div>
              <h2 className="text-sm font-semibold text-neutral-300 mb-2">
                Screen events ({events.length})
              </h2>
              <div className="border border-neutral-800 rounded-lg p-3 h-56 overflow-y-auto space-y-2 text-xs">
                {events.map((e) => (
                  <div key={e.id} className="flex gap-2">
                    <span className="text-neutral-500 shrink-0">[{fmtT(e.t)}]</span>
                    <span className="text-neutral-300">{e.summary}</span>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <h2 className="text-sm font-semibold text-neutral-300 mb-2">
                Mastery so far ({mastery.length})
              </h2>
              <div className="border border-neutral-800 rounded-lg p-3 space-y-1.5 text-sm">
                {mastery.length === 0 && <p className="text-neutral-600 text-xs">Nothing recorded yet.</p>}
                {mastery.map((m) => (
                  <div key={m.topic} className={m.mastered ? "text-emerald-400" : "text-amber-400"}>
                    {m.mastered ? "✓" : "→"} {m.topic}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
