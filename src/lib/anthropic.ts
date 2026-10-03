import Anthropic from "@anthropic-ai/sdk";

let client: Anthropic | null = null;

export function getAnthropic(): Anthropic {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        "ANTHROPIC_API_KEY is not set. Add it to .env.local (see .env.example)."
      );
    }
    client = new Anthropic({ apiKey });
  }
  return client;
}

export const VISION_MODEL = process.env.ANTHROPIC_VISION_MODEL || "claude-sonnet-5";
export const TEXT_MODEL = process.env.ANTHROPIC_TEXT_MODEL || "claude-sonnet-5";
