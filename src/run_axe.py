"""Baseline: run axe-core on every generated page and map rules to defect types."""
import argparse
import json
from pathlib import Path

from axe_playwright_python.sync_playwright import Axe
from playwright.sync_api import sync_playwright

RULE_MAP = {
    "label": "missing_label",
    "select-name": "missing_label",
    "aria-allowed-role": "wrong_role",
    "aria-required-attr": "wrong_role",
    "aria-valid-attr-value": "wrong_role",
    "tabindex": "focus_order",
    "color-contrast": "low_contrast",
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pages", default="data/pages")
    ap.add_argument("--out", default="runs/axe_results.json")
    a = ap.parse_args()
    reports, axe = [], Axe()
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page()
        for f in sorted(Path(a.pages).glob("*.html")):
            page.goto(f.resolve().as_uri())
            res = axe.run(page).response
            for v in res.get("violations", []):
                dtype = RULE_MAP.get(v["id"])
                if not dtype:
                    continue
                for node in v["nodes"]:
                    target = node["target"][0].lstrip("#")
                    reports.append({"page_id": f.stem, "element_id": target, "type": dtype, "rule": v["id"]})
        browser.close()
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    Path(a.out).write_text(json.dumps(reports, indent=1))
    print(f"axe-core: {len(reports)} mapped findings -> {a.out}")


if __name__ == "__main__":
    main()
