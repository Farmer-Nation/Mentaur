# Hackathon modifications

This build keeps the original Capture → Map → Teach sandbox flow and adds a generalized, low-credit real-screen path.

- **Claude on any shared screen:** one compressed current frame plus a compact prior-state summary; Claude returns a live activity summary, screen events, one grounded Guide question, and up to three Student suggestions in one response.
- **More live tracking:** local 32×18 pixel-delta checks still run about every 1.5 seconds, while the default dirty-screen Claude cadence is now 4 seconds. Claude activity summaries are persisted into chat with deduping/cooldown.
- **Periodic spoken questions:** high-value vision questions still use the normal pause window; after learner silence, the watcher reuses a recent Claude question or asks text-only Claude for a new screen-grounded prompt. Guide TTS prefers ElevenLabs. Question Mode can pause/resume all automatic prompts.
- **Screen-share self preview:** the Guide now sees a large live preview in the main workspace. Pause/resume freezes Mentaur relay/analysis without ending browser permission; both Guide and Student surfaces show paused state.
- **Voice:** ElevenLabs text-to-speech is preferred when configured; `eleven_flash_v2_5` is the default. Any ElevenLabs API or playback failure falls back to local browser speech synthesis.
- **Model defaults:** Claude Haiku 4.5 is used by default for vision/reasoning to minimize hackathon spend; both model IDs remain environment-configurable.
- **Privacy note:** use fake/sandbox data for demos. Output prompts avoid echoing obvious secrets, but real screenshots sent to Claude are external API inputs.

Run `npm test` from `ai-apprentice/` to verify the dependency-free brain tests.
