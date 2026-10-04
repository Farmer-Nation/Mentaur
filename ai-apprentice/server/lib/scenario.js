// The sandbox ERP scenario — the brief's running example.
// Shared by the planner (to know ground truth), the Work Map builder,
// and served to the browser so the ERP renders the same data.

export const COST_CENTERS = [
  { v: '', t: '— select cost center —' },
  { v: '4711', t: '4711 · Operating expense (opex)' },
  { v: '0400', t: '0400 · Capital expenditure (capex)' },
  { v: '5200', t: '5200 · Maintenance' },
];

export function captureInvoices() {
  return [
    {
      id: 'INV-4471', supplier: 'Baumann Maschinen GmbH',
      desc: 'CNC spindle assembly (equipment)', amount: 7500, country: 'DE',
      category: 'equipment',
      truth: {
        cc: '0400', action: 'approve',
        why: 'Equipment over €5,000 is always capex, not opex.',
        guardrail: 'No asset number, no capex booking. Unknown supplier → stop and ask the controller.',
      },
    },
    {
      id: 'INV-4472', supplier: 'Novák s.r.o. (Czech subsidiary)',
      desc: 'Contract tooling services', amount: 3200, country: 'CZ',
      category: 'services',
      truth: {
        cc: '4711', action: 'escalate',
        why: 'Anything from the Czech subsidiary needs a second approval — intercompany rules.',
        guardrail: 'Czech subsidiary invoices always route to a second approver before posting.',
      },
    },
    {
      id: 'INV-4473', supplier: 'Weber Supplies',
      desc: 'Monthly maintenance consumables', amount: 1840, country: 'DE',
      category: 'consumables', month: 'December',
      truth: {
        cc: '4711', action: 'hold',
        why: 'Weber double-bills every December, so I hold their December invoice and check it against November.',
        guardrail: 'Known double-biller in December → hold and reconcile before approval.',
      },
    },
  ];
}

// A case the expert never demonstrated, used in Teach mode.
export function teachInvoice() {
  return {
    id: 'INV-4480', supplier: 'Hartmann Werkzeug AG',
    desc: 'Precision lathe (equipment)', amount: 7200, country: 'DE',
    category: 'equipment',
    truth: {
      cc: '0400', action: 'approve',
      why: 'Equipment over €5,000 is always capex.',
      guardrail: 'No asset number, no capex booking.',
    },
  };
}
