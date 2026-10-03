"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ConversationProvider, useConversation } from "@elevenlabs/react";
import { useScreenCapture } from "@/lib/useScreenCapture";
import type {
  CaptureSession,
  QuestionLogEntry,
  QuestionType,
  ScreenEvent,
  TranscriptTurn,
} from "@/lib/types";

const QUESTION_TYPES: { type: QuestionType; label: string }[] = [
  { type: "why", label: "Why" },
  { type: "guardrail", label: "Guardrail" },
  { type: "exception", label: "Exception" },
];

function fmtT(ms: number) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${rem.toString().padStart(2, "0")}`;
}

export default function CapturePage() {
  return (
    <ConversationProvider>
      <CaptureInner />
    </ConversationProvider>
  );
}

function CaptureInner() {
  const router = useRouter();

  const [session, setSession] = useState<CaptureSession | null>(null);
  const [title, setTitle] = useState("Accounts Payable — Invoice Coding");
  const [expertName, setExpertName] = useState("Sabine");
  const [creating, setCreating] = useState(false);

  const [events, setEvents] = useState<ScreenEvent[]>([]);
  const [questions, setQuestions] = useState<QuestionLogEntry[]>([]);
  const [transcript, setTranscript] = useState<TranscriptTurn[]>([]);
  const [offTheRecord, setOffTheRecord] = useState(false);
  const [offRanges, setOffRanges] = useState<{ startT: number; endT: number | null }[]>([]);

  const startedAtRef = useRef(0);

  const conversation = useConversation({
    clientTools: {
      log_question: (params: { type: QuestionType; question: string }) => {
        setQuestions((q) => [
          ...q,
          {
            id: crypto.randomUUID(),
            t: Date.now() - startedAtRef.current,
            type: params.type,
            question: params.question,
          },
        ]);
        return "logged";
      },
    },
    onMessage: (m) => {
      if (!m.message) return;
      setTranscript((t) => [
        ...t,
        {
          id: crypto.randomUUID(),
          t: Date.now() - startedAtRef.current,
          role: m.source === "user" ? "expert" : "agent",
          text: m.message,
        },
      ]);
    },
    onError: (message) => {
      console.error("ElevenLabs conversation error", message);
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
        "PAUSE DETECTED: no visual change on screen for a few seconds — a natural moment to ask, if there's something worth asking about."
      );
    }
  }, [conversation]);

  const {
    videoRef,
    isSharing,
    error: captureError,
    start: startCaptureStream,
    stop: stopCaptureStream,
  } = useScreenCapture({
    pauseMs: 3000,
    muted: offTheRecord,
    onEvent: handleEvent,
    onPause: handlePause,
  });

  // autosave
  useEffect(() => {
    if (!session) return;
    const handle = setTimeout(() => {
      fetch(`/api/session/${session.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ events, questions, transcript, offTheRecordRanges: offRanges }),
      }).catch(() => {});
    }, 1500);
    return () => clearTimeout(handle);
  }, [session, events, questions, transcript, offRanges]);

  async function createSession() {
    setCreating(true);
    try {
      const res = await fetch("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, expertName }),
      });
      const data = await res.json();
      setSession(data.session);
    } finally {
      setCreating(false);
    }
  }

  async function startCapture() {
    startedAtRef.current = Date.now();
    await startCaptureStream();
    await navigator.mediaDevices.getUserMedia({ audio: true });
    const res = await fetch("/api/elevenlabs/signed-url?role=interviewer");
    const data = await res.json();
    if (!res.ok) {
      alert(data.error || "Could not connect to the ElevenLabs agent.");
      return;
    }
    await conversation.startSession({ signedUrl: data.signedUrl });
  }

  function toggleOffTheRecord() {
    setOffTheRecord((prev) => {
      const now = Date.now() - startedAtRef.current;
      if (!prev) {
        setOffRanges((r) => [...r, { startT: now, endT: null }]);
        conversation.setMuted?.(true);
      } else {
        setOffRanges((r) => {
          const copy = [...r];
          const last = copy[copy.length - 1];
          if (last && last.endT === null) last.endT = now;
          return copy;
        });
        conversation.setMuted?.(false);
      }
      return !prev;
    });
  }

  async function endAndGoToDebrief() {
    if (!session) return;
    conversation.endSession?.();
    stopCaptureStream();
    await fetch(`/api/session/${session.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        events,
        questions,
        transcript,
        offTheRecordRanges: offRanges,
        phase: "debrief",
      }),
    });
    router.push(`/map/${session.id}`);
  }

  const askedTypes = new Set(questions.map((q) => q.type));
  const guardrailAsked = questions.some((q) => q.type === "guardrail");
  const testPassing = questions.length >= 3 && guardrailAsked;

  if (!session) {
    return (
      <main className="max-w-lg mx-auto py-20 px-6">
        <h1 className="text-2xl font-semibold mb-1">Module 1 — Capture</h1>
        <p className="text-neutral-400 text-sm mb-8">
          Set up a session before sharing your screen with the apprentice.
        </p>
        <div className="space-y-4">
          <div>
            <label className="block text-xs uppercase tracking-wide text-neutral-500 mb-1.5">
              Workflow title
            </label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full bg-neutral-900 border border-neutral-700 rounded px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs uppercase tracking-wide text-neutral-500 mb-1.5">
              Expert name
            </label>
            <input
              value={expertName}
              onChange={(e) => setExpertName(e.target.value)}
              className="w-full bg-neutral-900 border border-neutral-700 rounded px-3 py-2 text-sm"
            />
          </div>
          <button
            onClick={createSession}
            disabled={creating}
            className="px-4 py-2 rounded bg-sky-700 hover:bg-sky-600 text-sm disabled:opacity-50"
          >
            {creating ? "Creating…" : "Create session"}
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="max-w-6xl mx-auto py-8 px-6">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold">{session.title}</h1>
          <p className="text-sm text-neutral-500">Expert: {session.expertName}</p>
        </div>
        <a
          href="/sandbox?set=a"
          target="_blank"
          rel="noreferrer"
          className="text-xs px-3 py-1.5 rounded border border-neutral-700 hover:bg-neutral-900"
        >
          Open sandbox ERP ↗
        </a>
      </div>

      {!isSharing ? (
        <div className="border border-neutral-800 rounded-lg p-6 mb-6">
          <p className="text-sm text-neutral-400 mb-4">
            1. Open the sandbox ERP in a new tab (button above) and get an invoice ready. <br />
            2. Click &quot;Start capture&quot;, then pick that tab (or window) in the share-screen
            prompt, and allow the microphone when asked. <br />
            3. Talk through the task as you normally would — the apprentice stays quiet and asks at
            natural pauses.
          </p>
          <button
            onClick={startCapture}
            className="px-4 py-2 rounded bg-sky-700 hover:bg-sky-600 text-sm"
          >
            Start capture
          </button>
          {captureError && <p className="text-sm text-red-400 mt-3">{captureError}</p>}
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-6">
          <div className="col-span-2 space-y-4">
            <div className="rounded-lg overflow-hidden border border-neutral-800 bg-black">
              <video ref={videoRef} muted className="w-full aspect-video object-contain" />
            </div>

            <div className="flex items-center gap-3">
              <span
                className={`text-xs px-2 py-1 rounded ${
                  conversation.status === "connected"
                    ? "bg-emerald-800 text-emerald-100"
                    : "bg-neutral-800 text-neutral-300"
                }`}
              >
                Agent: {conversation.status}
              </span>
              <span className="text-xs px-2 py-1 rounded bg-neutral-800 text-neutral-300">
                {conversation.isSpeaking ? "speaking…" : "listening"}
              </span>
              <button
                onClick={toggleOffTheRecord}
                className={`text-xs px-3 py-1.5 rounded border ${
                  offTheRecord
                    ? "border-amber-600 text-amber-300 bg-amber-900/30"
                    : "border-neutral-700 text-neutral-300 hover:bg-neutral-900"
                }`}
              >
                {offTheRecord ? "● Off the record — resume" : "Take this off the record"}
              </button>
              <button
                onClick={endAndGoToDebrief}
                className="ml-auto text-xs px-3 py-1.5 rounded bg-sky-700 hover:bg-sky-600"
              >
                End session → debrief
              </button>
            </div>

            <div>
              <h2 className="text-sm font-semibold text-neutral-300 mb-2">Live transcript</h2>
              <div className="border border-neutral-800 rounded-lg p-3 h-56 overflow-y-auto space-y-2 text-sm">
                {transcript.length === 0 && (
                  <p className="text-neutral-600">Conversation will appear here…</p>
                )}
                {transcript.map((t) => (
                  <div key={t.id}>
                    <span className="text-neutral-500 mr-2">[{fmtT(t.t)}]</span>
                    <span className={t.role === "agent" ? "text-sky-300" : "text-neutral-200"}>
                      {t.role === "agent" ? "Apprentice: " : `${session.expertName}: `}
                      {t.text}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="space-y-4">
            <div className="border border-neutral-800 rounded-lg p-4">
              <h2 className="text-sm font-semibold text-neutral-300 mb-2">Apprentice Test coverage</h2>
              <div className="flex flex-wrap gap-1.5 mb-2">
                {QUESTION_TYPES.map((qt) => (
                  <span
                    key={qt.type}
                    className={`text-xs px-2 py-1 rounded ${
                      askedTypes.has(qt.type)
                        ? "bg-sky-800 text-sky-100"
                        : "bg-neutral-800 text-neutral-500"
                    }`}
                  >
                    {qt.label}
                  </span>
                ))}
              </div>
              <p className={`text-xs ${testPassing ? "text-emerald-400" : "text-neutral-500"}`}>
                {questions.length} question{questions.length === 1 ? "" : "s"} asked
                {guardrailAsked ? " · guardrail covered" : " · needs a guardrail question"}
              </p>
            </div>

            <div>
              <h2 className="text-sm font-semibold text-neutral-300 mb-2">
                Screen events ({events.length})
              </h2>
              <div className="border border-neutral-800 rounded-lg p-3 h-80 overflow-y-auto space-y-2 text-xs">
                {events.length === 0 && (
                  <p className="text-neutral-600">Watching the shared screen…</p>
                )}
                {events.map((e) => (
                  <div key={e.id} className="flex gap-2">
                    <span className="text-neutral-500 shrink-0">[{fmtT(e.t)}]</span>
                    <span className="text-neutral-300">{e.summary}</span>
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
