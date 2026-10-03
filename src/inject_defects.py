"""Generate synthetic test pages with known, injected accessibility defects.

Ground truth is written to data/defects.json so recall and precision can be
measured for any auditor (axe-core, an LLM agent, ...).
"""
import argparse
import json
import random
from pathlib import Path

TYPES = ["missing_label", "wrong_role", "focus_order", "low_contrast", "misleading_alt"]
BAD_ALTS = ["image", "photo", "IMG_2041.jpg", "picture"]
GOOD_ALTS = [
    "Farmer drying coffee beans on a raised bed",
    "Bar chart of monthly rainfall",
    "Clinic waiting room with six chairs",
    "Hands holding a mobile phone",
]
SVG = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='80' height='60'/>"


class Page:
    def __init__(self, pid, rng, rate):
        self.pid, self.rng, self.rate = pid, rng, rate
        self.n = 0
        self.html = []
        self.defects = []

    def nid(self):
        self.n += 1
        return f"t-{self.n}"

    def flag(self):
        return self.rng.random() < self.rate

    def defect(self, dtype, ids):
        self.defects.append({
            "defect_id": f"{self.pid}-d{len(self.defects) + 1}",
            "page_id": self.pid, "type": dtype, "element_ids": ids,
        })

    def field(self):
        i, name = self.nid(), self.rng.choice(["Email", "Phone number", "Village", "Farm size"])
        if self.flag():
            self.html.append(f'<p><input id="{i}" type="text" placeholder="{name}"></p>')
            self.defect("missing_label", [i])
        else:
            self.html.append(f'<p><label for="{i}">{name}</label> <input id="{i}" type="text"></p>')

    def button(self):
        i, text = self.nid(), self.rng.choice(["Submit order", "Save changes", "Send message"])
        if self.flag():
            self.html.append(f'<div id="{i}" role="link" tabindex="0">{text}</div>')
            self.defect("wrong_role", [i])
        else:
            self.html.append(f'<p><button id="{i}" type="button">{text}</button></p>')

    def image(self):
        i = self.nid()
        if self.flag():
            self.html.append(f'<img id="{i}" src="{SVG}" alt="{self.rng.choice(BAD_ALTS)}">')
            self.defect("misleading_alt", [i])
        else:
            self.html.append(f'<img id="{i}" src="{SVG}" alt="{self.rng.choice(GOOD_ALTS)}">')

    def text(self):
        i = self.nid()
        if self.flag():
            self.html.append(f'<p id="{i}" style="color:#9a9a9a;background:#fff">Opening hours are 8am to 5pm.</p>')
            self.defect("low_contrast", [i])
        else:
            self.html.append(f'<p id="{i}" style="color:#222;background:#fff">Opening hours are 8am to 5pm.</p>')

    def tabgroup(self):
        g = self.nid()
        ids = [self.nid() for _ in range(3)]
        if self.flag():
            idx = [3, 1, 2]
            btns = "".join(f'<button id="{b}" type="button" tabindex="{t}">Step {k + 1}</button>'
                           for k, (b, t) in enumerate(zip(ids, idx)))
            self.defect("focus_order", [g] + ids)
        else:
            btns = "".join(f'<button id="{b}" type="button">Step {k + 1}</button>' for k, b in enumerate(ids))
        self.html.append(f'<div id="{g}">{btns}</div>')


def build(pid, rng, rate):
    p = Page(pid, rng, rate)
    parts = [p.field, p.button, p.image, p.text, p.tabgroup]
    for fn in rng.sample(parts, k=rng.randint(4, 5)):
        fn()
    html = (f'<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Test page {pid}</title></head>'
            f'<body><main><h1>Test page {pid}</h1>{"".join(p.html)}</main></body></html>')
    return html, p.defects


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=40)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--rate", type=float, default=0.5, help="chance each component gets a defect")
    ap.add_argument("--out", default="data/pages")
    ap.add_argument("--defects", default="data/defects.json")
    a = ap.parse_args()
    rng = random.Random(a.seed)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    all_defects = []
    for k in range(1, a.n + 1):
        pid = f"p{k:03d}"
        html, defects = build(pid, rng, a.rate)
        (out / f"{pid}.html").write_text(html, encoding="utf-8")
        all_defects += defects
    Path(a.defects).write_text(json.dumps(all_defects, indent=1))
    print(f"wrote {a.n} pages and {len(all_defects)} labelled defects (seed={a.seed})")


if __name__ == "__main__":
    main()
