"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { CaptureSession } from "@/lib/types";

export default function NewTeachForm() {
  const router = useRouter();
  const params = useSearchParams();
  const sourceId = params.get("source") || "";

  const [source, setSource] = useState<CaptureSession | null>(null);
  const [newHireName, setNewHireName] = useState("Lena");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sourceId) return;
    fetch(`/api/session/${sourceId}`)
      .then((r) => r.json())
      .then((d) => setSource(d.session));
  }, [sourceId]);

  async function start() {
    setCreating(true);
    setError(null);
    const res = await fetch("/api/teach", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceSessionId: sourceId, newHireName }),
    });
    const data = await res.json();
    setCreating(false);
    if (!res.ok) {
      setError(data.error || "Could not start teach session");
      return;
    }
    router.push(`/teach/${data.teachSession.id}`);
  }

  if (!sourceId) {
    return (
      <main className="max-w-lg mx-auto py-20 px-6 text-neutral-500 text-sm">
        Missing source session. Build a Work Map first from the Capture / Debrief flow.
      </main>
    );
  }

  return (
    <main className="max-w-lg mx-auto py-20 px-6">
      <h1 className="text-2xl font-semibold mb-1">Module 3 — Teach</h1>
      <p className="text-neutral-400 text-sm mb-8">
        A new hire will work a fresh case while the tutor watches and coaches, using the Work Map
        from {source ? `"${source.title}"` : "…"}.
      </p>

      {source?.workMap && (
        <div className="border border-neutral-800 rounded-lg p-4 mb-6 text-sm text-neutral-400">
          {source.workMap.steps.length} steps · {source.workMap.guardrailCount} guardrails learned
          from {source.expertName}
        </div>
      )}

      <div className="space-y-4">
        <div>
          <label className="block text-xs uppercase tracking-wide text-neutral-500 mb-1.5">
            New hire name
          </label>
          <input
            value={newHireName}
            onChange={(e) => setNewHireName(e.target.value)}
            className="w-full bg-neutral-900 border border-neutral-700 rounded px-3 py-2 text-sm"
          />
        </div>
        <button
          onClick={start}
          disabled={creating || !source?.workMap}
          className="px-4 py-2 rounded bg-sky-700 hover:bg-sky-600 text-sm disabled:opacity-50"
        >
          {creating ? "Starting…" : "Start teach session"}
        </button>
        {error && <p className="text-sm text-red-400">{error}</p>}
      </div>
    </main>
  );
}
