// The question planner — the heart of the challenge.
//
// Two jobs, kept separate on purpose:
//   1. WHAT to ask  -> questionFor(): only produces questions that reveal a
//      reason or a guardrail, never something the screen already answers.
//   2. WHEN to ask  -> shouldSpeak(): the expert must have paused (no activity)
//      and not be typing, and the agent must not already be talking.
//
// This module is pure (no I/O) so it can be unit-tested and reused by both the
// mock pipeline and the vision pipeline.

const PAUSE_MS = 2200; // silence/no-activity window that counts as "a pause"

// Produce a candidate question for an on-screen event, or null.
// `inv` is the invoice after the change. `trigger` is 'cc' | 'action'.
export function questionFor(trigger, inv) {
  if (!inv) return null;

  // Judgment call: coding a big equipment invoice to capex.
  if (trigger === 'cc' && inv.category === 'equipment' && inv.cc === '0400') {
    return key(inv, 'capex', `You coded ${inv.id} to capex. What made you do that?`, false, 'code_cc');
  }
  // Guardrail: big equipment left on an opex code — is that deliberate?
  if (trigger === 'cc' && inv.category === 'equipment' && inv.cc === '4711' && inv.amount > 5000) {
    return key(inv, 'opex-big', `That's equipment over €5,000 on an opex code. Deliberate, or should it be capex?`, true, 'code_cc');
  }
  // Guardrail: holding an invoice.
  if (trigger === 'action' && inv.action === 'hold') {
    return key(inv, 'hold', `You held ${inv.id}. Is that for every supplier, or just this one — and who decides when to release it?`, true, 'hold');
  }
  // Guardrail: routing for a second approval.
  if (trigger === 'action' && inv.action === 'escalate') {
    return key(inv, 'esc', `Why does ${inv.id} need a second approval before it posts?`, true, 'escalate');
  }
  // Guardrail-by-omission: approving equipment straight through.
  if (trigger === 'action' && inv.action === 'approve' && inv.category === 'equipment') {
    return key(inv, 'appr', `You approved ${inv.id} straight through. What would have made you stop and ask someone instead?`, true, 'approve');
  }
  return null;
}

function key(inv, suffix, q, guardrail, stepKey) {
  return { key: `${inv.id}:${suffix}`, q, guardrail, stepKey, invId: inv.id };
}

// WHEN: given the live session clock and the last activity time, is now a good
// moment to release a queued question?
export function shouldSpeak(sess, nowMs) {
  if (!sess.queued) return false;
  if (sess.speaking) return false;
  if (sess.pending) return false; // one question at a time
  if (sess.typing) return false; // stay quiet while they type
  return nowMs - sess.lastActivity >= PAUSE_MS;
}

// Debrief: everything the agent still lacks a reason or a guardrail for.
export function debriefQuestions(invoices, qa) {
  const out = [];
  for (const inv of invoices) {
    if (!inv.action) continue; // not processed
    const haveWhy = qa.some((x) => x.invId === inv.id && !x.guardrail);
    const haveGuard = qa.some((x) => x.invId === inv.id && x.guardrail);
    if (!haveWhy) {
      out.push({ invId: inv.id, guardrail: false, stepKey: 'debrief_why',
        q: `On ${inv.id} (${inv.supplier}) — I never caught why you decided the way you did. What was the reason?` });
    }
    if (!haveGuard) {
      out.push({ invId: inv.id, guardrail: true, stepKey: 'debrief_guard',
        q: `For ${inv.id}, is there a limit or exception where you'd stop and ask someone instead of deciding yourself?` });
    }
  }
  out.push({ invId: null, guardrail: true, stepKey: 'debrief_general',
    q: `Last one: across all of these, what's the single mistake a new hire is most likely to make?` });
  return out;
}

// Coverage model used for "when it has understood".
export function coverage(invoices, qa) {
  const items = [];
  for (const inv of invoices) {
    if (!inv.action) continue;
    items.push({ inv: inv.id, label: `${inv.id} — reason for the decision`,
      ok: qa.some((x) => x.invId === inv.id && !x.guardrail) });
    items.push({ inv: inv.id, label: `${inv.id} — guardrail / when to stop`,
      ok: qa.some((x) => x.invId === inv.id && x.guardrail) });
  }
  return items;
}

export function isUnderstood(invoices, qa) {
  const c = coverage(invoices, qa);
  return c.length > 0 && c.every((x) => x.ok);
}

// Teach: did the new hire break a guardrail on the unseen case?
// Returns { ok } or { ok:false, question, scoreLabel, scoreNote }.
export function evaluateTeachDecision(teachInv, chosen) {
  const wrongCC = chosen.cc !== teachInv.truth.cc; // equipment > €5k must be capex
  if (wrongCC) {
    return {
      ok: false,
      question:
        `Hold on — your guide would stop here. This is equipment over €5,000, and they told me: ` +
        `"equipment over €5,000 is always capex." You've got it on ${chosen.cc ? 'code ' + chosen.cc : 'no code yet'}. ` +
        `Change it before you post?`,
      scoreLabel: 'Code equipment over €5,000 to capex',
      scoreNote: `You reached for ${chosen.cc ? 'code ' + chosen.cc : 'an empty code'}. Your guide would code this to capex (0400).`,
      guardrail: teachInv.truth.guardrail,
    };
  }
  return { ok: true, scoreLabel: 'Code equipment over €5,000 to capex',
    scoreNote: 'Coded straight to capex (0400) — guardrail respected.' };
}

export const constants = { PAUSE_MS };
