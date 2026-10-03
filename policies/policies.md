# Policies

Enforce these in Omnigent at the orchestration layer (tool permissions and policies), not only in prompts.
**TODO(verify):** translate each rule into the Omnigent policy syntax from the docs.

| Rule | Why |
|---|---|
| Experiment runner has no network access except the approved LLM API | Keeps runs reproducible and contained |
| Calling the external LLM API requires human approval the first time | Consequential, costs money |
| Cumulative model spend pauses at a fixed cap (set in README) | Budget control |
| No real user data enters data/ | Privacy; this project uses synthetic pages only |
| Promoting a hypothesis to the next experiment requires human approval | The scientist owns the research direction |
