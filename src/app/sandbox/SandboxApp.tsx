"use client";

import { useSearchParams } from "next/navigation";
import { useState } from "react";
import {
  SANDBOX_SET_A,
  SANDBOX_SET_B,
  COST_CENTERS,
  type ApprovalStatus,
} from "./data";

interface RowState {
  costCenter: "4711" | "0400";
  status: ApprovalStatus;
  note: string;
}

const STATUS_LABEL: Record<ApprovalStatus, string> = {
  pending: "Pending",
  approved: "Approved",
  held: "On hold",
  second_approval_requested: "Sent for second approval",
};

const STATUS_COLOR: Record<ApprovalStatus, string> = {
  pending: "bg-neutral-700 text-neutral-200",
  approved: "bg-emerald-700 text-emerald-100",
  held: "bg-amber-700 text-amber-100",
  second_approval_requested: "bg-sky-700 text-sky-100",
};

export default function SandboxApp() {
  const params = useSearchParams();
  const setParam = params.get("set") === "b" ? "b" : "a";
  const invoices = setParam === "b" ? SANDBOX_SET_B : SANDBOX_SET_A;

  const [rows, setRows] = useState<Record<string, RowState>>(() =>
    Object.fromEntries(
      invoices.map((inv) => [
        inv.id,
        { costCenter: inv.defaultCostCenter, status: "pending" as ApprovalStatus, note: "" },
      ])
    )
  );
  const [openId, setOpenId] = useState<string | null>(invoices[0]?.id ?? null);

  const open = invoices.find((i) => i.id === openId) || null;
  const openRow = openId ? rows[openId] : null;

  function update(id: string, patch: Partial<RowState>) {
    setRows((r) => ({ ...r, [id]: { ...r[id], ...patch } }));
  }

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100">
      <header className="border-b border-neutral-800 px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="h-7 w-7 rounded bg-sky-600 flex items-center justify-center text-sm font-bold">M</div>
          <div>
            <div className="text-sm font-semibold leading-tight">MBT ERP — Accounts Payable</div>
            <div className="text-xs text-neutral-500 leading-tight">Invoice processing — month-end close</div>
          </div>
        </div>
        <div className="text-xs text-neutral-500">
          Case set: <span className="font-mono text-neutral-300">{setParam.toUpperCase()}</span> · signed in as{" "}
          <span className="text-neutral-300">ap-clerk@mbt-stuttgart.example</span>
        </div>
      </header>

      <div className="flex">
        <div className="w-[380px] border-r border-neutral-800 min-h-[calc(100vh-57px)]">
          <div className="px-4 py-3 text-xs uppercase tracking-wide text-neutral-500">
            Open invoices ({invoices.length})
          </div>
          <ul>
            {invoices.map((inv) => {
              const row = rows[inv.id];
              return (
                <li key={inv.id}>
                  <button
                    onClick={() => setOpenId(inv.id)}
                    className={`w-full text-left px-4 py-3 border-b border-neutral-900 hover:bg-neutral-900 transition-colors ${
                      openId === inv.id ? "bg-neutral-900" : ""
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-sm">#{inv.number}</span>
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded ${STATUS_COLOR[row.status]}`}
                      >
                        {STATUS_LABEL[row.status]}
                      </span>
                    </div>
                    <div className="text-sm text-neutral-200 mt-0.5">{inv.supplier}</div>
                    <div className="text-xs text-neutral-500 mt-0.5 flex justify-between">
                      <span>{inv.subsidiary}</span>
                      <span>
                        €{inv.amount.toLocaleString("de-DE", { minimumFractionDigits: 2 })}
                      </span>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="flex-1 p-6">
          {!open || !openRow ? (
            <div className="text-neutral-500 text-sm">Select an invoice.</div>
          ) : (
            <div className="max-w-xl">
              <div className="flex items-baseline justify-between mb-1">
                <h1 className="text-xl font-semibold">Invoice #{open.number}</h1>
                <span className={`text-xs px-2 py-1 rounded ${STATUS_COLOR[openRow.status]}`}>
                  {STATUS_LABEL[openRow.status]}
                </span>
              </div>
              <div className="text-sm text-neutral-400 mb-6">
                {open.supplier} · {open.subsidiary} · received {open.receivedDate}
              </div>

              <dl className="grid grid-cols-2 gap-y-3 text-sm mb-6">
                <dt className="text-neutral-500">Description</dt>
                <dd>{open.description}</dd>
                <dt className="text-neutral-500">Amount</dt>
                <dd className="font-mono">
                  €{open.amount.toLocaleString("de-DE", { minimumFractionDigits: 2 })}
                </dd>
                <dt className="text-neutral-500">Supplier</dt>
                <dd>{open.supplier}</dd>
                <dt className="text-neutral-500">Subsidiary</dt>
                <dd>{open.subsidiary}</dd>
              </dl>

              <div className="border-t border-neutral-800 pt-5 space-y-5">
                <div>
                  <label className="block text-xs uppercase tracking-wide text-neutral-500 mb-1.5">
                    Cost center
                  </label>
                  <select
                    value={openRow.costCenter}
                    onChange={(e) =>
                      update(open.id, { costCenter: e.target.value as "4711" | "0400" })
                    }
                    className="w-full bg-neutral-900 border border-neutral-700 rounded px-3 py-2 text-sm"
                  >
                    {COST_CENTERS.map((c) => (
                      <option key={c.code} value={c.code}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs uppercase tracking-wide text-neutral-500 mb-1.5">
                    Note
                  </label>
                  <textarea
                    value={openRow.note}
                    onChange={(e) => update(open.id, { note: e.target.value })}
                    rows={2}
                    placeholder="Optional note for the file..."
                    className="w-full bg-neutral-900 border border-neutral-700 rounded px-3 py-2 text-sm"
                  />
                </div>

                <div className="flex flex-wrap gap-2 pt-1">
                  <button
                    onClick={() => update(open.id, { status: "approved" })}
                    className="px-3 py-1.5 rounded bg-emerald-700 hover:bg-emerald-600 text-sm"
                  >
                    Approve
                  </button>
                  <button
                    onClick={() => update(open.id, { status: "held" })}
                    className="px-3 py-1.5 rounded bg-amber-700 hover:bg-amber-600 text-sm"
                  >
                    Hold
                  </button>
                  <button
                    onClick={() => update(open.id, { status: "second_approval_requested" })}
                    className="px-3 py-1.5 rounded bg-sky-700 hover:bg-sky-600 text-sm"
                  >
                    Send for second approval
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
