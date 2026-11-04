// Explicit, bounded local provider check. Never prints tokens, provider messages or credentials.
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

if (process.env.LIVE_INTERACTION_CHECK !== '1') throw new Error('Set LIVE_INTERACTION_CHECK=1 for this paid local check.');
const url = process.env.INTERACTION_URL || 'http://127.0.0.1:5173';
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(url)) throw new Error('This check is local only.');
await mkdir('artifacts/interaction', { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const deadline = setTimeout(() => { void browser.close(); }, 100_000);
try {
  await page.addInitScript(() => {
    window.__trace = []; window.__rings = []; window.__micRequests = 0;
    const record = (direction, event) => {
      window.__trace.push({ at: performance.now(), direction, type: event.type,
        responseId: event.response_id ?? event.response?.id, status: event.response?.status,
        code: typeof event.error?.code === 'string' ? event.error.code : undefined });
    };
    const Peer = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends Peer {
      createDataChannel(...args) {
        const channel = super.createDataChannel(...args); window.__channel = channel;
        const send = channel.send.bind(channel);
        channel.send = value => { try { record('out', JSON.parse(value)); } catch {} return send(value); };
        channel.addEventListener('message', event => { try { record('in', JSON.parse(event.data)); } catch {} });
        return channel;
      }
    };
    const AudioConstructor = window.Audio;
    window.Audio = function(...args) { const audio = new AudioConstructor(...args); window.__rings.push(audio); return audio; };
    window.Audio.prototype = AudioConstructor.prototype;
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (...args) => { window.__micRequests++; return getUserMedia(...args); };
    const create = document.createElement.bind(document);
    document.createElement = function(name, ...args) {
      const element = create(name, ...args);
      if (name.toLowerCase() === 'audio') window.__nativeAudio = element;
      return element;
    };
  });
  await page.goto(url, { waitUntil: 'networkidle' });
  // Keep the existing decorative title-button wobble out of Playwright's stability wait.
  await page.addStyleTag({ content: '.start-button { animation: none !important; }' });
  await page.getByRole('button', { name: 'Start the game' }).click();
  await page.waitForFunction(() => window.__rings.some(audio => /iphone-ringtone/.test(audio.src) && !audio.paused), undefined, { timeout: 8000 });
  await page.getByRole('button', { name: 'Answer the call' }).click();
  assert.equal(await page.evaluate(() => window.__rings.every(audio => audio.paused)), true, 'Answer must stop the ring immediately.');
  await page.getByRole('button', { name: 'How to play' }).waitFor({ timeout: 30000 });
  assert.match(await page.locator('.connection-note').first().innerText(), /Natural voice/);
  await page.evaluate(async () => {
    window.__game = await import('/src/game/session.ts');
    const stream = window.__nativeAudio.srcObject;
    window.__chunks = []; window.__recorder = new MediaRecorder(stream);
    window.__recorder.ondataavailable = event => { if (event.data.size) window.__chunks.push(event.data); };
    window.__recorder.start(250);
  });
  const turns = [];
  const settle = async index => {
    await page.waitForFunction(index => {
      const events = window.__trace.slice(index);
      const phone = document.querySelector('[data-testid="phone"]');
      const state = window.__game.simulation.readState();
      const started = events.some(e => e.direction === 'in' && e.type === 'output_audio_buffer.started');
      const requested = events.filter(e => e.direction === 'out' && e.type === 'response.create').length;
      const created = events.filter(e => e.direction === 'in' && e.type === 'response.created').length;
      const idle = started && requested === created && phone?.dataset.voiceSpeaking === 'false'
        && phone?.dataset.voiceResponding === 'false' && !state.active && !state.queue.length;
      if (!idle) { window.__quietSince = null; return false; }
      window.__quietSince ??= performance.now();
      return performance.now() - window.__quietSince > 600;
    }, index, { timeout: 35000 });
  };
  const send = async (text, wait = true) => {
    const index = await page.evaluate(() => { window.__quietSince = null; return window.__trace.length; });
    const sent = await page.evaluate(() => performance.now());
    await page.getByLabel('Tell Grandma what to do').fill(text);
    await page.getByRole('button', { name: 'Send instruction' }).click();
    if (wait) await settle(index);
    if (wait) {
      const events = await page.evaluate(index => window.__trace.slice(index), index);
      turns.push({ text, firstAudioMs: Math.round(events.find(e => e.type === 'output_audio_buffer.started')?.at - sent), events });
      assert.match(await page.locator('.connection-note').first().innerText(), /Natural voice/);
    }
    return index;
  };
  await send('Say exactly: All right, sweetheart. I am listening.');
  // Reproduce the recoverable idle-cancellation error that previously closed the whole call.
  await page.evaluate(() => window.__channel.send(JSON.stringify({ type: 'response.cancel' })));
  await page.waitForFunction(() => window.__trace.some(e => e.type === 'error' && e.code === 'response_cancel_not_active'), undefined, { timeout: 5000 });
  assert.match(await page.locator('.connection-note').first().innerText(), /Natural voice/);
  await send('Turn off selfie mode. Reply in five words.');
  await page.locator('[data-camera-mode="rear"]').waitFor();
  await send('Walk to the red toolbox. Keep your reply to five words.');
  const index = await send('Count slowly from one to ten.', false);
  await page.waitForFunction(index => window.__trace.slice(index).some(e => e.type === 'output_audio_buffer.started'), index);
  await send('Stop counting. Tell me you are still here.');
  const recording = await page.evaluate(async () => {
    await new Promise(resolve => { window.__recorder.onstop = resolve; window.__recorder.stop(); });
    return Array.from(new Uint8Array(await new Blob(window.__chunks).arrayBuffer()));
  });
  assert.ok(recording.length > 5000);
  assert.equal(await page.evaluate(() => window.__micRequests), 0);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: 'artifacts/interaction/live.png', animations: 'disabled' });
  const report = { url, turns, trace: await page.evaluate(() => window.__trace), nativeAudioBytes: recording.length,
    transcript: await page.getByRole('log').innerText(), ringtoneStarted: true, ringtoneStoppedOnAnswer: true, microphoneRequests: 0, errors };
  await writeFile('artifacts/interaction/live.webm', Buffer.from(recording));
  await writeFile('artifacts/interaction/live.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: true, turns: turns.map(({ text, firstAudioMs }) => ({ text, firstAudioMs })), nativeAudioBytes: recording.length, recoveredIdleCancellation: true, ringtoneStarted: true, ringtoneStoppedOnAnswer: true, microphoneRequests: 0, errors }, null, 2));
} catch (error) {
  await page.screenshot({ path: 'artifacts/interaction/failure.png' }).catch(() => {});
  console.error('Check failed:', error.message);
  console.error('Voice mode:', await page.locator('.connection-note').allTextContents().catch(() => []));
  await writeFile('artifacts/interaction/failure-trace.json', JSON.stringify(await page.evaluate(() => window.__trace).catch(() => []), null, 2));
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide'))).catch(() => {});
  await browser.close();
}
