// Voice adapter for ElevenLabs.
// ElevenLabs TTS is preferred whenever an API key is configured. The browser
// automatically falls back to local Web Speech if this endpoint is unavailable
// or generation/playback fails.

const KEY = process.env.ELEVENLABS_API_KEY;
const AGENT_ID = process.env.ELEVENLABS_AGENT_ID;
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL';
const TTS_MODEL = process.env.ELEVENLABS_TTS_MODEL || 'eleven_flash_v2_5';

export const voiceMode = KEY ? (AGENT_ID ? 'elevenlabs' : 'elevenlabs-tts') : 'local';

export async function getSignedUrl() {
  if (!KEY || !AGENT_ID) return null;
  const r = await fetch(
    `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${encodeURIComponent(AGENT_ID)}`,
    { headers: { 'xi-api-key': KEY } },
  );
  if (!r.ok) throw new Error('signed url failed: ' + r.status);
  const data = await r.json();
  return data.signed_url;
}

// Returns a Buffer of MP3 audio, or null when ElevenLabs is unavailable.
export async function tts(text) {
  if (!KEY || !text) return null;
  try {
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}?output_format=mp3_22050_32`, {
      method: 'POST',
      headers: { 'xi-api-key': KEY, 'content-type': 'application/json', accept: 'audio/mpeg' },
      body: JSON.stringify({
        text: String(text).slice(0, 1200),
        model_id: TTS_MODEL,
        voice_settings: { stability: 0.4, similarity_boost: 0.8 },
      }),
    });
    if (!r.ok) throw new Error('tts failed: ' + r.status);
    return Buffer.from(await r.arrayBuffer());
  } catch (e) {
    console.warn('[voice] ElevenLabs unavailable; client will use local TTS:', e.message);
    return null;
  }
}
