// The sandbox ERP scenario — the brief's running example.
// Shared by the planner (to know ground truth), the Work Map builder,
// and served to the browser so the ERP renders the same data.

export const COST_CENTERS = [
  { v: '', t: '— choose inventory action —' },
  { v: 'stock', t: 'Put into stock' },
  { v: 'reorder', t: 'Reorder now' },
  { v: 'quarantine', t: 'Quarantine and inspect' },
];

// A single, easy-to-explain case for live demos. The full invoice set remains
// available for regression tests and can be restored without changing the
// planner or room protocol.
export function simpleDemoInvoices() {
  return [
    {
      id: 'ITEM-101', supplier: 'Northstar Office',
      desc: 'Wireless keyboards', amount: 4, country: 'Shelf A', condition: 'sealed', photo: '⌨️',
      note: 'Receiving note: count confirmed. No open purchase order is visible.',
      category: 'inventory',
      truth: {
        cc: 'reorder', action: 'escalate',
        why: 'Only four are left and the reorder point is ten, so I reorder before we run out.',
        guardrail: 'Do not reorder if the count has not been verified or the item is already on an open purchase order.',
      },
    },
    {
      id: 'ITEM-102', supplier: 'Northstar Office',
      desc: 'USB-C docking stations', amount: 18, country: 'Shelf B', condition: 'sealed', photo: '🔌',
      note: 'Receiving note: two cartons are still sealed; count matches the packing slip.',
      category: 'inventory',
      truth: {
        cc: 'stock', action: 'approve',
        why: 'The count is above the reorder point, so I record it and leave it in stock.',
        guardrail: 'If the count is damaged or mismatched, stop and inspect before stocking it.',
      },
    },
    {
      id: 'ITEM-103', supplier: 'Northstar Office',
      desc: 'Laptop chargers', amount: 7, country: 'Receiving', condition: 'damaged box', photo: '🔋',
      note: 'Receiving note: outer carton is crushed and three serial numbers are unreadable.',
      category: 'inventory',
      truth: {
        cc: 'quarantine', action: 'hold',
        why: 'The package is damaged, so I keep it out of stock until it is inspected.',
        guardrail: 'Never put damaged or unverified items into available stock.',
      },
    },
  ];
}

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

// Legacy invoice practice case retained for compatibility with the planner
// unit tests. The live demo uses teachInventory below.
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

export function teachInventory() {
  return teachInventoryCases()[0];
}

export function teachInventoryCases() {
  return [
    {
    id: 'ITEM-104', supplier: 'Northstar Office',
    desc: 'Wireless mice', amount: 3, country: 'Receiving', condition: 'unverified', photo: '🖱️',
    note: 'Receiving note: the delivery arrived without a signed count sheet.',
    category: 'inventory',
    truth: {
      cc: 'quarantine', action: 'hold',
      why: 'The count is not verified, so I quarantine it before stocking it.',
      guardrail: 'Never put unverified items into available stock.',
    },
    },
    {
      id: 'ITEM-105', supplier: 'Northstar Office',
      desc: 'Ergonomic monitors', amount: 6, country: 'Shelf C', condition: 'sealed',
      photo: '🖥️', note: 'Receiving note: count matches the packing slip; one open purchase order exists.',
      category: 'inventory',
      truth: {
        cc: 'stock', action: 'approve',
        why: 'The count is verified and the items are sealed, so I stock them.',
        guardrail: 'If the delivery does not match the packing slip, stop before stocking it.',
      },
    },
    {
      id: 'ITEM-106', supplier: 'Northstar Office',
      desc: 'USB-C cables', amount: 2, country: 'Shelf D', condition: 'sealed',
      photo: '🔗', note: 'Receiving note: stock is below the reorder point and no purchase order is open.',
      category: 'inventory',
      truth: {
        cc: 'reorder', action: 'escalate',
        why: 'Two units remain and there is no open purchase order, so I reorder.',
        guardrail: 'Verify the count and check open purchase orders before reordering.',
      },
    },
    {
      id: 'ITEM-107', supplier: 'Northstar Office',
      desc: 'Barcode scanners', amount: 4, country: 'Receiving', condition: 'sealed',
      photo: '📷', note: 'Receiving note: the count matches, but one scanner has a different model number.',
      category: 'inventory',
      truth: {
        cc: 'quarantine', action: 'hold',
        why: 'The model mismatch needs inspection before the delivery can be stocked.',
        guardrail: 'Stop when the model or serial details do not match the expected delivery.',
      },
    },
    {
      id: 'ITEM-108', supplier: 'Northstar Office',
      desc: 'Packing labels', amount: 24, country: 'Shelf E', condition: 'sealed',
      photo: '🏷️', note: 'Receiving note: the labels are sealed, the count matches, and stock is healthy.',
      category: 'inventory',
      truth: {
        cc: 'stock', action: 'approve',
        why: 'The delivery is verified and there is no signal that it needs a special action.',
        guardrail: 'If the package is opened or the count changes, verify it again before stocking.',
      },
    },
  ];
}
