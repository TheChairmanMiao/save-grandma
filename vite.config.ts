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

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  // Public builds are static and must never advertise development-only voice endpoints.
  const voiceAvailable = mode === 'development' && !!env.OPENAI_API_KEY;
  return {
    // Only assets imported by the game ship; retain the original recordings/models as source references.
    publicDir: false,
    plugins: [react(), realtimeToken(env.OPENAI_API_KEY)],
    // Expose availability only; the OpenAI key never enters the browser bundle.
    define: {
      'import.meta.env.VITE_VOICE_AVAILABLE': JSON.stringify(String(voiceAvailable)),
    },
    build: { rollupOptions: { output: { manualChunks: { three: ['three', '@react-three/fiber'] } } } },
  };
});
