import { defineConfig, loadEnv, type Connect, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { REALTIME_MODEL } from './src/voice/model';

// Mints short-lived Realtime client secrets so OPENAI_API_KEY never reaches the browser.
function realtimeToken(apiKey: string | undefined): Plugin {
  const handler: Connect.NextHandleFunction = async (req, res, next) => {
    if (req.url !== '/api/realtime-token' || req.method !== 'POST') return next();
    res.setHeader('Content-Type', 'application/json');
    if (!apiKey) { res.statusCode = 500; res.end(JSON.stringify({ error: 'OPENAI_API_KEY is not set. Add it to .env.local and restart.' })); return; }
    try {
      const response = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: { type: 'realtime', model: REALTIME_MODEL } }),
      });
      const data = await response.json() as { value?: string; error?: { message?: string } };
      if (!response.ok || !data.value) { res.statusCode = 502; res.end(JSON.stringify({ error: data.error?.message ?? 'Could not create a Realtime client secret.' })); return; }
      res.end(JSON.stringify({ value: data.value }));
    } catch (error) {
      res.statusCode = 502; res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  };
  return { name: 'realtime-token', configureServer: server => { server.middlewares.use(handler); }, configurePreviewServer: server => { server.middlewares.use(handler); } };
}

// Grandma's ElevenLabs voice. The browser posts { text }; the key and voice ID stay here.
const ELEVENLABS_MODEL = 'eleven_flash_v2_5';
function speakProxy(apiKey: string | undefined, voiceId: string | undefined): Plugin {
  const handler: Connect.NextHandleFunction = async (req, res, next) => {
    if (req.url !== '/api/speak' || req.method !== 'POST') return next();
    if (!apiKey || !voiceId) { res.statusCode = 500; res.end('ELEVENLABS_API_KEY / ELEVENLABS_VOICE_ID are not set.'); return; }
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const { text } = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { text?: string };
      if (typeof text !== 'string' || !text.trim() || text.length > 1000) { res.statusCode = 400; res.end('Expected { text } under 1000 characters.'); return; }
      const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=mp3_44100_128`, {
        method: 'POST',
        headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, model_id: ELEVENLABS_MODEL, voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.3, use_speaker_boost: true } }),
      });
      if (!response.ok || !response.body) { res.statusCode = 502; res.end(`ElevenLabs ${response.status}: ${(await response.text().catch(() => '')).slice(0, 300)}`); return; }
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Cache-Control', 'no-store');
      const reader = response.body.getReader();
      for (;;) { const { done, value } = await reader.read(); if (done) break; res.write(value); }
      res.end();
    } catch (error) {
      res.statusCode = 502; res.end(error instanceof Error ? error.message : String(error));
    }
  };
  return { name: 'elevenlabs-speak', configureServer: server => { server.middlewares.use(handler); }, configurePreviewServer: server => { server.middlewares.use(handler); } };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  // Public builds are static and must never advertise development-only voice endpoints.
  const voiceAvailable = mode === 'development' && !!env.OPENAI_API_KEY;
  const elevenlabs = voiceAvailable && !!(env.ELEVENLABS_API_KEY && env.ELEVENLABS_VOICE_ID);
  return {
    // Only assets imported by the game ship; retain the original recordings/models as source references.
    publicDir: false,
    plugins: [react(), realtimeToken(env.OPENAI_API_KEY), speakProxy(env.ELEVENLABS_API_KEY, env.ELEVENLABS_VOICE_ID)],
    // Tells the browser whether Grandma's ElevenLabs voice is available (never the key itself).
    define: {
      'import.meta.env.VITE_ELEVENLABS_VOICE': JSON.stringify(String(elevenlabs)),
      'import.meta.env.VITE_VOICE_AVAILABLE': JSON.stringify(String(voiceAvailable)),
    },
    build: { rollupOptions: { output: { manualChunks: { three: ['three', '@react-three/fiber'] } } } },
  };
});
