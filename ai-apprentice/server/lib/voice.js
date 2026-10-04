// Voice adapter for ElevenLabs.
// ElevenLabs TTS is preferred whenever an API key is configured. The browser
// automatically falls back to local Web Speech if this endpoint is unavailable
// or generation/playback fails.

const KEY = process.env.ELEVENLABS_API_KEY;
const AGENT_ID = process.env.ELEVENLABS_AGENT_ID;
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL';
const TTS_MODEL = process.env.ELEVENLABS_TTS_MODEL || 'eleven_flash_v2_5';
// eleven_flash_v2_5 / eleven_multilingual_v2 speak Japanese and Vietnamese text
// directly — no separate "language" request param needed, just the right voice.
const VOICE_ID_BY_LANG = {
  ja: process.env.ELEVENLABS_VOICE_ID_JA || VOICE_ID,
  vi: process.env.ELEVENLABS_VOICE_ID_VI || VOICE_ID,
};

export const voiceMode = KEY ? (AGENT_ID ? 'elevenlabs' : 'elevenlabs-tts') : 'local';

async function providerError(prefix, response) {
  const detail = (await response.text()).replace(/\s+/g, ' ').trim().slice(0, 300);
  return new Error(`${prefix} ${response.status}${detail ? `: ${detail}` : ''}`);
}

export async function getSignedUrl() {
  if (!KEY || !AGENT_ID) return null;
  const r = await fetch(
    `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${encodeURIComponent(AGENT_ID)}`,
    { headers: { 'xi-api-key': KEY } },
  );
  if (!r.ok) throw await providerError('signed url failed:', r);
  const data = await r.json();
  return data.signed_url;
}

// Returns a Buffer of MP3 audio, or null when ElevenLabs is unavailable.
// `lang` ('ja' | 'vi') selects a language-specific voice when configured.
export async function tts(text, lang) {
  if (!KEY || !text) return null;
  const voiceId = (lang && VOICE_ID_BY_LANG[lang]) || VOICE_ID;
  try {
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_22050_32&optimize_streaming_latency=4`, {
      method: 'POST',
      headers: { 'xi-api-key': KEY, 'content-type': 'application/json', accept: 'audio/mpeg' },
      body: JSON.stringify({
        text: String(text).slice(0, 1200),
        model_id: TTS_MODEL,
        voice_settings: { stability: 0.4, similarity_boost: 0.8 },
      }),
    });
    if (!r.ok) throw await providerError('tts failed:', r);
    return Buffer.from(await r.arrayBuffer());
  } catch (e) {
    console.warn('[voice] ElevenLabs unavailable; client will use local TTS:', e.message);
    return null;
  }
}
