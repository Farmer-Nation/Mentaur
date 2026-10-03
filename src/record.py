"""Write a structured handoff into record/. Agents call this so every decision is reconstructable.

Usage: python src/record.py --from analyst --to insight --type result \
  --refs r-002 H3 --claim "..." --evidence runs/results.json --confidence low
"""
import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

REC = Path("record")


def write(frm, to, typ, refs, claim, evidence, confidence):
    REC.mkdir(exist_ok=True)
    n = len(list(REC.glob("h-*.json"))) + 1
    item = {
        "id": f"h-{n:03d}", "time": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "from": frm, "to": to, "type": typ, "refs": refs, "claim": claim,
        "evidence": evidence, "confidence": confidence, "label": "agent-generated",
    }
    (REC / f"{item['id']}.json").write_text(json.dumps(item, indent=1))
    return item["id"]


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="frm", required=True)
    ap.add_argument("--to", required=True)
    ap.add_argument("--type", required=True, choices=["finding", "hypothesis", "plan", "result", "approval", "decision"])
    ap.add_argument("--refs", nargs="*", default=[])
    ap.add_argument("--claim", required=True)
    ap.add_argument("--evidence", nargs="*", default=[])
    ap.add_argument("--confidence", choices=["low", "med", "high"], default="low")
    a = ap.parse_args()
    print(write(a.frm, a.to, a.type, a.refs, a.claim, a.evidence, a.confidence))
