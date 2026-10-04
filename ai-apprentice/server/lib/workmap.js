// Builds the Work Map: one step per processed item, each linking a screen
// moment, the decision, the reason in the expert's own words, and guardrails.

function fmt(ms) {
  const s = Math.floor((ms || 0) / 1000);
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}

export function buildWorkMap(sess) {
  const { invoices, qa, events } = sess;
  if (sess.captureMode === 'screen') {
    const answers = qa.filter((x) => x.a && x.stepKey !== 'student_q');
    const lastEvent = events.at(-1);
    const reason = answers.find((x) => !x.guardrail)?.a || 'Captured from the shared session.';
    const guardrail = answers.find((x) => x.guardrail)?.a || 'Stop and ask for help when the evidence or next step is unclear.';
    return [{
      idx: 1,
      title: 'Shared workflow session',
      moment: lastEvent ? fmt(lastEvent.t) : '—',
      momentWhat: lastEvent?.text || 'Observed work on the shared screen',
      decision: 'Follow the workflow demonstrated in the session',
      signal: events.slice(-3).map((e) => e.text).join(' · ') || 'Shared-screen evidence',
      evidence: events.slice(-3).map((e) => e.text),
      reason,
      reasonWho: answers.some((x) => !x.guardrail) ? 'expert, during the session' : 'inferred',
      guardrail,
      judgment: true,
      hasGuard: answers.some((x) => x.guardrail),
      invId: null,
      tutorial: ['Observe the shared workflow and its evidence.', 'Follow the demonstrated decision process.', 'Stop and verify when the guardrail applies.'],
    }];
  }
  const steps = [];
  invoices.forEach((inv, i) => {
    if (!inv.action) return;
    const whyQA = qa.find((x) => x.invId === inv.id && !x.guardrail);
    const guardQA = qa.find((x) => x.invId === inv.id && x.guardrail);
    const openEv = events.find((e) => e.text.includes(inv.id + ' opened'));
    const decEv = events.find(
      (e) => e.text.includes(inv.id) &&
        (e.text.includes('cost center') || e.text.includes('approved') ||
         e.text.includes('held') || e.text.includes('2nd') || e.text.includes('second')),
    );
    steps.push({
      idx: i + 1,
      title: `Receive ${inv.id} — ${inv.desc}`,
      moment: decEv ? fmt(decEv.t) : openEv ? fmt(openEv.t) : '—',
      momentWhat: `${inv.id} · ${inv.category}${inv.cc ? ' · inventory decision ' + inv.cc : ''}`,
      decision: decisionText(inv),
      signal: inv.note || `${inv.amount} units at ${inv.country}`,
      evidence: [inv.condition, inv.note].filter(Boolean),
      reason: whyQA ? whyQA.a : inv.truth.why,
      reasonWho: whyQA ? 'expert, during the session' : 'inferred',
      guardrail: guardQA ? guardQA.a : inv.truth.guardrail,
      judgment: inv.category === 'inventory' || inv.category === 'equipment' || inv.action !== 'approve',
      hasGuard: !!(guardQA || inv.truth.guardrail),
      invId: inv.id,
      tutorial: [
        `Observe: ${inv.desc} (${inv.amount} units, ${inv.condition || 'condition unknown'}).`,
        `Decide: ${decisionText(inv)} when the evidence supports it.`,
        `Act: complete the inventory action.`,
        `Verify: ${inv.truth.guardrail}`,
      ],
    });
  });
  return steps;
}

function decisionText(inv) {
  const act = inv.category === 'inventory'
    ? { approve: 'Put into stock', hold: 'Quarantined', escalate: 'Reorder queued' }[inv.action]
    : { approve: 'Approved & posted', hold: 'Held for reconciliation', escalate: 'Sent for 2nd approval' }[inv.action] || 'Handled';
  const decision = inv.cc ? ` · ${inv.cc === 'stock' ? 'put into stock' : inv.cc === 'reorder' ? 'reorder now' : inv.cc === 'quarantine' ? 'quarantine and inspect' : inv.cc}` : '';
  return act + decision;
}

// Agent-ready export: instructions a downstream agent can load.
export function toAgentJSON(sess) {
  const steps = buildWorkMap(sess);
  return {
    workflow: 'Inventory receiving — stock, reorder, or quarantine',
    summary: `This demo shows how to inspect an incoming item, choose stock, reorder, or quarantine, and verify the evidence before continuing.`,
    tutorial: [
      'Observe the quantity, condition, location, and receiving note.',
      'Decide which action the evidence supports.',
      'Complete the matching inventory action.',
      'Verify what would make you stop and ask for help.',
    ],
    captured_at: new Date().toISOString(),
    steps: steps.map((s) => ({
      step: s.idx, title: s.title, screen_moment: s.moment,
      decision: s.decision, reason: s.reason, guardrails: s.guardrail,
      signal: s.signal, tutorial: s.tutorial,
      judgment_call: s.judgment,
    })),
    agent_instructions:
      'Follow the tutorial and steps in order. At each “when to stop” condition, ask a human rather than deciding alone.',
  };
}
