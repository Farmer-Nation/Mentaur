"""Plain-Python fallback to test the experiment WITHOUT Omnigent.

This is for debugging only. The submission must be orchestrated by Omnigent agents
(see agents/ and README.md).
"""
import subprocess
import sys

steps = [
    [sys.executable, "src/inject_defects.py", "--n", "40"],
    [sys.executable, "src/run_axe.py"],
    [sys.executable, "src/run_agent_audit.py", "--repeats", "3"],
    [sys.executable, "src/analyze.py"],
]
for s in steps:
    print(">>", " ".join(s))
    subprocess.run(s, check=True)
