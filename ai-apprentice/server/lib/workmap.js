// Builds the Work Map: one step per processed invoice, each linking a screen
// moment, the decision, the reason in the expert's own words, and guardrails.

function fmt(ms) {
  const s = Math.floor((ms || 0) / 1000);
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}

export function buildWorkMap(sess) {
  const { invoices, qa, events } = sess;
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
      title: `Process ${inv.id} — ${inv.supplier}`,
      moment: decEv ? fmt(decEv.t) : openEv ? fmt(openEv.t) : '—',
      momentWhat: `${inv.id} · ${inv.category}${inv.cc ? ' · cost center ' + inv.cc : ''}`,
      decision: decisionText(inv),
      reason: whyQA ? whyQA.a : inv.truth.why,
      reasonWho: whyQA ? 'expert, during the session' : 'inferred',
      guardrail: guardQA ? guardQA.a : inv.truth.guardrail,
      judgment: inv.category === 'equipment' || inv.action !== 'approve',
      hasGuard: !!(guardQA || inv.truth.guardrail),
      invId: inv.id,
    });
  });
  return steps;
}

function decisionText(inv) {
  const act = { approve: 'Approved & posted', hold: 'Held for reconciliation', escalate: 'Sent for 2nd approval' }[inv.action] || 'Handled';
  const cc = inv.cc ? ` · coded ${inv.cc === '0400' ? 'capex (0400)' : inv.cc === '4711' ? 'opex (4711)' : inv.cc}` : '';
  return act + cc;
}

// Agent-ready export: instructions a downstream agent can load.
export function toAgentJSON(sess) {
  const steps = buildWorkMap(sess);
  return {
    workflow: 'Accounts payable — month-end invoice processing',
    captured_at: new Date().toISOString(),
    steps: steps.map((s) => ({
      step: s.idx, title: s.title, screen_moment: s.moment,
      decision: s.decision, reason: s.reason, guardrails: s.guardrail,
      judgment_call: s.judgment,
    })),
    agent_instructions:
      'Follow steps in order. At each guardrail, stop and ask a human rather than deciding.',
  };
}
