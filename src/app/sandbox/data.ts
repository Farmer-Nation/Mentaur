export interface SandboxInvoice {
  id: string;
  number: string;
  supplier: string;
  subsidiary: string;
  amount: number;
  currency: string;
  description: string;
  receivedDate: string;
  defaultCostCenter: "4711" | "0400";
}

// Set A: the running example from the challenge brief, for the expert
// (Module 1 Capture) to process while screen-sharing.
export const SANDBOX_SET_A: SandboxInvoice[] = [
  {
    id: "inv-4471",
    number: "4471",
    supplier: "Mueller Antriebstechnik GmbH",
    subsidiary: "DE - Stuttgart (HQ)",
    amount: 7850,
    currency: "EUR",
    description: "CNC spindle assembly, qty 1",
    receivedDate: "2026-09-29",
    defaultCostCenter: "4711",
  },
  {
    id: "inv-4832",
    number: "4832",
    supplier: "Baltic Fasteners s.r.o.",
    subsidiary: "CZ - Brno",
    amount: 2340,
    currency: "EUR",
    description: "M8 bolts, bulk order",
    receivedDate: "2026-09-30",
    defaultCostCenter: "4711",
  },
  {
    id: "inv-4590",
    number: "4590",
    supplier: "Rhein Spedition Logistik",
    subsidiary: "DE - Stuttgart (HQ)",
    amount: 4120,
    currency: "EUR",
    description: "December freight surcharge",
    receivedDate: "2026-09-28",
    defaultCostCenter: "4711",
  },
];

// Set B: a case the expert never showed, for the new hire (Module 3 Teach)
// — includes a fresh capex trap (>€5,000 equipment coded as opex by default).
export const SANDBOX_SET_B: SandboxInvoice[] = [
  {
    id: "inv-5102",
    number: "5102",
    supplier: "Voss Elektromotoren",
    subsidiary: "DE - Stuttgart (HQ)",
    amount: 7200,
    currency: "EUR",
    description: "Replacement servo motor, qty 2",
    receivedDate: "2026-10-01",
    defaultCostCenter: "4711",
  },
  {
    id: "inv-5118",
    number: "5118",
    supplier: "Rhein Spedition Logistik",
    subsidiary: "DE - Stuttgart (HQ)",
    amount: 1890,
    currency: "EUR",
    description: "October freight surcharge",
    receivedDate: "2026-10-01",
    defaultCostCenter: "4711",
  },
  {
    id: "inv-5133",
    number: "5133",
    supplier: "Baltic Fasteners s.r.o.",
    subsidiary: "CZ - Brno",
    amount: 3450,
    currency: "EUR",
    description: "Hex nuts, bulk order",
    receivedDate: "2026-10-02",
    defaultCostCenter: "4711",
  },
];

export type ApprovalStatus = "pending" | "approved" | "held" | "second_approval_requested";

export const COST_CENTERS: { code: "4711" | "0400"; label: string }[] = [
  { code: "4711", label: "4711 — Opex (general operating expense)" },
  { code: "0400", label: "0400 — Capex (capital equipment)" },
];
