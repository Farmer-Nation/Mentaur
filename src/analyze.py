"""Score axe-core and the LLM agent against ground truth, per defect type."""
import argparse
import glob
import json
from pathlib import Path

TYPES = ["missing_label", "wrong_role", "focus_order", "low_contrast", "misleading_alt"]


def score(defects, reports):
    out = {}
    for t in TYPES:
        ds = [d for d in defects if d["type"] == t]
        rs = [r for r in reports if r["type"] == t]
        hit = lambda d, r: r["page_id"] == d["page_id"] and r["element_id"] in d["element_ids"]
        tp = sum(1 for d in ds if any(hit(d, r) for r in rs))
        fp = sum(1 for r in rs if not any(hit(d, r) for d in ds))
        out[t] = {
            "defects": len(ds), "tp": tp, "fp": fp,
            "recall": tp / len(ds) if ds else None,
            "precision": tp / (tp + fp) if (tp + fp) else None,
        }
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--defects", default="data/defects.json")
    ap.add_argument("--axe", default="runs/axe_results.json")
    ap.add_argument("--agent", default="runs/agent_r*.json")
    ap.add_argument("--out", default="runs/results.json")
    a = ap.parse_args()

    defects = json.loads(Path(a.defects).read_text())
    axe = score(defects, json.loads(Path(a.axe).read_text()))
    agent_runs = [score(defects, json.loads(Path(f).read_text())["reports"]) for f in sorted(glob.glob(a.agent))]

    summary = {}
    for t in TYPES:
        recs = [r[t]["recall"] for r in agent_runs if r[t]["recall"] is not None]
        summary[t] = {
            "axe_recall": axe[t]["recall"],
            "agent_recall_mean": sum(recs) / len(recs) if recs else None,
            "agent_recall_min": min(recs) if recs else None,
            "agent_recall_max": max(recs) if recs else None,
            "n_defects": axe[t]["defects"], "n_repeats": len(recs),
        }
    scored = [(t, s["agent_recall_mean"]) for t, s in summary.items() if s["agent_recall_mean"] is not None]
    nxt = min(scored, key=lambda x: x[1])[0] if scored else None
    result = {"axe": axe, "agent_repeats": agent_runs, "summary": summary, "next_experiment_target": nxt}
    Path(a.out).write_text(json.dumps(result, indent=1))

    f = lambda v: "  -  " if v is None else f"{v * 100:5.0f}%"
    print(f"{'type':16} {'axe':>6} {'agent':>6} {'range':>12}  n")
    for t, s in summary.items():
        rng = f"{f(s['agent_recall_min'])}-{f(s['agent_recall_max'])}"
        print(f"{t:16} {f(s['axe_recall'])} {f(s['agent_recall_mean'])} {rng:>12}  {s['n_defects']}")
    print("next experiment target (agent's weakest type):", nxt)


if __name__ == "__main__":
    main()
