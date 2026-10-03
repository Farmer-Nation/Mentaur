import Link from "next/link";

export default function Home() {
  return (
    <main className="max-w-4xl mx-auto px-6 py-16">
      <div className="mb-14">
        <p className="text-xs uppercase tracking-widest text-sky-500 mb-3">
          Hack-Nation × ElevenLabs — 7th Global AI Hackathon
        </p>
        <h1 className="text-3xl font-semibold mb-3">The AI Apprentice</h1>
        <p className="text-neutral-400 max-w-2xl">
          An apprentice that watches how screen work is really done, asks why, maps the workflow
          with its guardrails, and teaches the next hire what the expert knows — before it walks
          out the door.
        </p>
      </div>

      <div className="grid gap-4 mb-14">
        <Link
          href="/capture"
          className="border border-neutral-800 rounded-lg p-5 hover:bg-neutral-900 transition-colors block"
        >
          <div className="text-xs text-sky-500 mb-1">Module 1</div>
          <div className="text-lg font-semibold mb-1">Capture</div>
          <p className="text-sm text-neutral-400">
            Share your screen and do a real task. The apprentice stays silent while you work and
            asks at natural pauses — why this step, is there a limit, when would you stop and ask
            someone. At least three live questions, one about a guardrail.
          </p>
        </Link>

        <div className="border border-neutral-800 rounded-lg p-5">
          <div className="text-xs text-sky-500 mb-1">Module 2</div>
          <div className="text-lg font-semibold mb-1">Map</div>
          <p className="text-sm text-neutral-400">
            Reached automatically at the end of a capture session. A spoken debrief closes the
            gaps, ends with a teach-back the expert confirms, and produces a clickable Work Map —
            every step linked to its screen moment, decision, reason, and guardrails.
          </p>
        </div>

        <div className="border border-neutral-800 rounded-lg p-5">
          <div className="text-xs text-sky-500 mb-1">Module 3</div>
          <div className="text-lg font-semibold mb-1">Teach</div>
          <p className="text-sm text-neutral-400">
            Started from a finished Work Map (via its &quot;Start Teach session&quot; link). A new
            hire works a fresh case while the tutor watches, explains steps the way the expert
            did, and catches a wrong decision before it&apos;s saved.
          </p>
        </div>

        <a
          href="/sandbox?set=a"
          target="_blank"
          rel="noreferrer"
          className="border border-neutral-800 rounded-lg p-5 hover:bg-neutral-900 transition-colors block"
        >
          <div className="text-xs text-neutral-500 mb-1">Sandbox</div>
          <div className="text-lg font-semibold mb-1">Fake ERP ↗</div>
          <p className="text-sm text-neutral-400">
            No workflow of your own handy? This is the screen to share: three invoices, one over
            the €5,000 capex line, one from a supplier that double-bills every December, one from
            the Czech subsidiary needing a second approval.
          </p>
        </a>
      </div>

      <div className="border-t border-neutral-800 pt-8">
        <h2 className="text-sm font-semibold text-neutral-300 mb-2">The moonshot</h2>
        <p className="text-sm text-neutral-500 max-w-2xl">
          Today&apos;s MVP captures one expert, one task, one new hire. Every additional expert who
          runs a capture session adds to the same company-wide Work Map — a living memory that
          stays current because the apprentice only has to ask about what changed, not relearn
          everything. From there: an always-on apprentice that notices unfamiliar cases during
          everyday work, agent-ready guardrails so routine steps can be automated safely while
          people keep the judgment calls, and eventually an anonymized operations manual for how
          the world&apos;s digital work actually gets done.
        </p>
      </div>
    </main>
  );
}
