"""LLM auditor: reads each page's HTML as a screen-reader user would and reports barriers.

Limitation (state this in the demo): the auditor sees HTML source, not a rendered page.
"""
import argparse
import json
import os
from pathlib import Path

import anthropic

TYPES = ["missing_label", "wrong_role", "focus_order", "low_contrast", "misleading_alt"]
SYSTEM = f"""You are an accessibility auditor simulating a screen-reader and keyboard user.
Given page HTML, list real barriers. Allowed types: {', '.join(TYPES)}.
- missing_label: form control with no accessible name
- wrong_role: element whose role does not match its visible purpose
- focus_order: keyboard tab order that does not follow reading order
- low_contrast: text that is hard to read against its background
- misleading_alt: image alt text that does not describe the image
Return ONLY a JSON list: [{{"element_id": "t-3", "type": "missing_label", "reason": "..."}}].
element_id must be an id attribute present in the HTML. Return [] if there are no barriers."""


def parse(text):
    try:
        return json.loads(text[text.index("["): text.rindex("]") + 1])
    except ValueError:
        return None  # unparseable: caller records it as an error, never guesses


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pages", default="data/pages")
    ap.add_argument("--repeats", type=int, default=1)
    ap.add_argument("--start", type=int, default=1, help="first repeat number")
    ap.add_argument("--limit", type=int, default=0, help="only audit the first N pages (cost control)")
    a = ap.parse_args()
    client = anthropic.Anthropic()
    model = os.environ.get("AUDIT_MODEL", "claude-sonnet-5-5")
    files = sorted(Path(a.pages).glob("*.html"))
    if a.limit:
        files = files[: a.limit]
    for r in range(a.start, a.start + a.repeats):
        reports, errors = [], []
        for f in files:
            msg = client.messages.create(model=model, max_tokens=1500, system=SYSTEM,
                                         messages=[{"role": "user", "content": f.read_text()}])
            text = "".join(b.text for b in msg.content if b.type == "text")
            found = parse(text)
            if found is None:
                errors.append(f.stem)
                continue
            for item in found:
                if item.get("type") in TYPES:
                    reports.append({"page_id": f.stem, "element_id": item.get("element_id"),
                                    "type": item["type"], "reason": item.get("reason", "")})
        out = Path(f"runs/agent_r{r}.json")
        out.write_text(json.dumps({"model": model, "errors": errors, "reports": reports}, indent=1))
        print(f"repeat {r}: {len(reports)} findings, {len(errors)} unparseable -> {out}")


if __name__ == "__main__":
    main()
