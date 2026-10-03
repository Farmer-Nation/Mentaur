# Experiment design

**Question:** Do LLM agents detect screen-reader barriers that a rule-based linter (axe-core) misses, and which barrier type should be tested next?

**Data:** 40 synthetic pages, 5 defect types, defects injected by script (ground truth in data/defects.json).

**Baseline:** axe-core, with rules mapped to defect types in src/run_axe.py.

**Condition:** an LLM auditor that reads the page HTML (src/run_agent_audit.py), 3-5 repeats.

**Metrics:** recall and precision per defect type; agent range across repeats.

**Decision rule:** the agent's weakest defect type becomes the next experiment target.

## Limitations (say these out loud)
- Pages are synthetic and simpler than real sites.
- The auditor reads HTML source, not a rendered page, so contrast is judged from inline styles.
- axe-core rule mapping is a judgement call; document any change.
- No disabled users were involved. Real validation needs screen-reader users on real sites.
- Precision mixes defect and report counts; treat it as approximate.

## Measuring acceleration
Time one page audited by hand by a person, then compare with the lab's time per page. Report the multiplier you actually observe.
