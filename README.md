# AI Discovery Lab


## Layout
```
agents/      one directory per agent: config.yaml + prompt.md
policies/    approval gates and limits (to be enforced in Omnigent)
src/         inject_defects.py, run_axe.py, run_agent_audit.py, analyze.py, record.py
record/      shared research record (one JSON file per handoff)
data/        generated pages + ground truth
runs/        raw outputs and results.json
app/server.py  local server + agent loop
ui/index.html  interactive lab UI;  ui/prototype.html is the old static mock
docs/        experiment design and limitations
scripts/run_pipeline.py   plain-Python fallback for debugging, not the submission path
```

## Setup
```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
playwright install chromium
cp .env.example .env      # add ANTHROPIC_API_KEY, then: export $(cat .env | xargs)
```

Install Omnigent (open source, from its GitHub repo):
```bash
uv tool install omnigent      # or: pip install omnigent
omnigent                      # first run / setup
```

## Interactive lab (blank workspace: upload data, type commands)
```bash
python app/server.py          # from the repo root, in a terminal where ANTHROPIC_API_KEY is set
```
Open http://127.0.0.1:8000. Drop files on the left, type a command at the bottom, approve actions on the right, click a room to see its activity, handoffs, results and files. "Open in new tab" gives each room its own page.

`app/server.py` currently runs the agents as a direct tool-using loop on the Anthropic API so the UI works today. **The submission must be orchestrated by Omnigent**: replace `run_agent()` with Omnigent sessions (TODO verify against the Omnigent docs). The tool permissions and the approval gate in that file are the part to keep.

Limits: one command at a time; uploaded files are readable by agents but only the audit experiment has runnable scripts; the server only listens on 127.0.0.1.

## Run the experiment pieces by hand (sanity check)
```bash
python src/inject_defects.py --n 40
python src/run_axe.py
python src/run_agent_audit.py --repeats 3 --limit 10   # start small to control cost
python src/analyze.py
```

## Run as the Omnigent lab (the real submission)
1. Verify in the Omnigent docs how to define sub-agents, handoffs and policies (TODO items in `agents/*/config.yaml` and `policies/policies.md`).
2. Start the orchestrator with the objective above.
3. Confirm the demo shows: parallel literature + data, two candidate plans from the planner, a human approval, a result that reopens a hypothesis, and a follow-up plan.

## Responsible use
Synthetic pages only. No real user data. Hypotheses are labelled agent-generated. See `docs/experiment.md` for limitations and the validation still needed.

## Submission checklist
- [ ] Repo + agent specs and policies
- [ ] 2-minute demo
- [ ] Cited evidence
- [ ] Experiment code + `runs/results.json`
- [ ] Measured improvement (observed multiplier, not a claim)
- [ ] Next experiment, taken from `next_experiment_target`
