// Explicit opt-in: this makes one short, real OpenAI call. Never run it as a routine check.
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

function within(pending, milliseconds, message) {
  let timer;
  return Promise.race([
    pending,
    new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); }),
  ]).finally(() => clearTimeout(timer));
}

async function confirmCallClosure(response, bodyTimeout = 5000) {
  assert.ok(response.ok(), 'The server did not accept the Realtime call-close request.');
  // Keepalive responses can leave Playwright response.finished() pending indefinitely.
  const receipt = await within(response.json(), bodyTimeout, 'The call-close receipt could not be read before the cleanup deadline.');
  assert.ok(receipt?.closed === true, 'The server did not confirm that the Realtime call is closed.');
  return { attempted: true, serverConfirmed: true, status: response.status() };
}

async function saveAuditionReport(filename, evidence, closeCall, write = writeFile) {
  const draft = { ...evidence, complete: false, cleanup: { attempted: true, pending: true, serverConfirmed: false } };
  await write(filename, JSON.stringify(draft, null, 2));
  const cleanup = await closeCall();
  const complete = { ...evidence, complete: true, cleanup };
  await write(filename, JSON.stringify(complete, null, 2));
  return complete;
}

async function checkCleanup() {
  let finishedCalled = false;
  const response = { ok: () => true, status: () => 200, json: async () => ({ closed: true }), finished: () => { finishedCalled = true; return new Promise(() => {}); } };
  assert.equal((await within(confirmCallClosure(response), 100, 'Mock cleanup hung.')).serverConfirmed, true);
  assert.equal(finishedCalled, false);
  assert.equal((await confirmCallClosure({ ok: () => true, status: () => 200, json: async () => ({ closed: true }) })).status, 200);
  await assert.rejects(confirmCallClosure({ ok: () => true, status: () => 200, json: () => new Promise(() => {}) }, 15), /cleanup deadline/);
  await assert.rejects(confirmCallClosure({ ok: () => true, status: () => 202, json: async () => ({ closed: false, pending: true }) }), /did not confirm/);
  await assert.rejects(within(new Promise(() => {}), 15, 'Total cleanup deadline.'), /Total cleanup deadline/);
  const writes = [];
  const write = async (_filename, text) => { writes.push(JSON.parse(text)); };
  const report = await saveAuditionReport('mock.json', { nativeAudioBytes: 123, stateEvidence: [{ cameraMode: 'rear' }] }, async () => {
    assert.equal(writes.length, 1);
    assert.equal(writes[0].complete, false);
    assert.equal(writes[0].nativeAudioBytes, 123);
    return { serverConfirmed: true };
  }, write);
  assert.equal(report.complete, true);
  assert.equal(writes[1].cleanup.serverConfirmed, true);
  const failureWrites = [];
  await assert.rejects(saveAuditionReport('mock.json', { nativeAudioBytes: 456 }, async () => { throw new Error('Mock close failure.'); }, async (_filename, text) => { failureWrites.push(JSON.parse(text)); }), /Mock close failure/);
  assert.equal(failureWrites.length, 1);
  assert.equal(failureWrites[0].nativeAudioBytes, 456);
  assert.equal(failureWrites[0].complete, false);
  console.log('Cleanup mock checks passed: stalled/absent finished(), bounded receipts and cleanup, confirmed closure, and preserved drafts. No browser or provider calls made.');
}

if (process.argv.length > 2) {
  if (process.argv.length !== 3 || process.argv[2] !== '--check-cleanup') throw new Error('The only supported argument is --check-cleanup.');
  await checkCleanup();
  process.exit(0);
}

if (process.env.LIVE_AUDITION !== '1') throw new Error('Set LIVE_AUDITION=1 to run the paid, bounded voice audition.');
const publicAudition = process.env.PUBLIC_AUDITION === '1';
const canonicalPublicUrl = 'https://save-grandma-demo.resoluteflame.chatgpt.site';
const url = process.env.AUDITION_URL || (publicAudition ? canonicalPublicUrl : 'http://127.0.0.1:5173');
if (publicAudition) {
  if (url !== canonicalPublicUrl) throw new Error('Public auditions are restricted to the exact canonical Save Grandma demo URL.');
} else if (!/^http:\/\/(?:127\.0\.0\.1|localhost):\d+\/?$/.test(url)) {
  throw new Error('Remote auditions require PUBLIC_AUDITION=1 and the exact canonical Save Grandma demo URL.');
}
const origin = new URL(url).origin;
const closeUrl = new URL('/api/realtime-close', url).href;
const artifact = `artifacts/${publicAudition ? 'grandma-public-audition' : 'grandma-native-audition'}`;
await mkdir('artifacts', { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const errors = [];
const stateEvidence = [];
let startedCall = false;
let connectedOnce = false;
let closeResponse;
let closing;
let busyCheck;
page.on('pageerror', error => errors.push(error.message));
page.on('response', response => {
  if (response.url() === closeUrl && response.request().method() === 'POST') closeResponse = response;
});

// Pausing hushes output but deliberately keeps the call alive. Pagehide owns actual teardown.
function endCall() {
  if (closing) return closing;
  closing = within((async () => {
    if (!startedCall || page.isClosed()) return { attempted: false };
    const help = page.getByRole('button', { name: 'How to play' });
    if (await help.isVisible().catch(() => false)) await help.click();
    const pendingClose = publicAudition && connectedOnce
      ? closeResponse ? Promise.resolve(closeResponse) : page.waitForResponse(response => response.url() === closeUrl && response.request().method() === 'POST', { timeout: 12_000 })
      : null;
    // Attach a rejection handler immediately while the pagehide event is being dispatched.
    if (pendingClose) void pendingClose.catch(() => {});
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    if (pendingClose) {
      const response = await pendingClose;
      return confirmCallClosure(response);
    }
    await page.waitForFunction(() => !window.__grandmaAudio?.srcObject, undefined, { timeout: 5000 });
    return { attempted: true, clientClosed: true, serverConfirmed: false };
  })(), 12_000, 'Realtime call cleanup exceeded its twelve-second deadline.');
  return closing;
}
const timeout = setTimeout(() => {
  // This independent bound still closes the browser if the shared cleanup promise stalls.
  void within(endCall(), 12_000, 'Audition shutdown deadline.').catch(() => {})
    .finally(() => within(browser.close(), 5000, 'Browser shutdown deadline.').catch(() => {}));
}, 90_000);
const started = Date.now();
try {
  await page.addInitScript(() => {
    const create = document.createElement.bind(document);
    document.createElement = function(name, ...args) {
      const element = create(name, ...args);
      if (name.toLowerCase() === 'audio') window.__grandmaAudio = element;
      return element;
    };
    // Count permission requests; typed AI should make none.
    window.__microphoneRequests = 0;
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (...args) => { window.__microphoneRequests++; return getUserMedia(...args); };
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(url, { waitUntil: 'networkidle' });
  startedCall = true;
  await page.getByRole('button', { name: 'Start the game' }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('.connection-note')].some(n => n.textContent.includes('Natural voice')) || [...document.querySelectorAll('.connection-note')].some(n => n.textContent.includes('couldn’t connect')), undefined, { timeout: 25_000 });
  const mode = await page.locator('.connection-note').first().innerText();
  assert.match(mode, /Natural voice/, 'The real AI connection did not become ready. Check provider setup.');
  connectedOnce = true;

  if (publicAudition) {
    // This context has a separate cookie jar and never starts another provider call.
    const otherVisitor = await browser.newContext();
    try {
      const response = await otherVisitor.request.post(new URL('/api/realtime-token', url).href, { headers: { Origin: origin } });
      const data = await response.json().catch(() => ({}));
      // If the limit regresses, release any accidental reservation without exposing its token.
      if (response.ok() && data.relay === true && typeof data.value === 'string') {
        await otherVisitor.request.post(closeUrl, { headers: { Origin: origin, Authorization: `Bearer ${data.value}` } }).catch(() => {});
      }
      assert.equal(response.status(), 409, 'A second visitor must be rejected while Grandma is on the first call.');
      assert.ok(data.code === 'BUSY', 'The second visitor did not receive the BUSY code.');
      busyCheck = { isolatedContext: true, status: response.status(), code: 'BUSY' };
    } finally { await otherVisitor.close(); }
  }

  await page.evaluate(() => {
    const stream = window.__grandmaAudio?.srcObject;
    if (!stream?.getAudioTracks().length) throw new Error('No native incoming audio track.');
    window.__voiceChunks = [];
    window.__voiceRecorder = new MediaRecorder(stream);
    window.__voiceRecorder.ondataavailable = event => { if (event.data.size) window.__voiceChunks.push(event.data); };
    window.__voiceRecorder.start(250);
  });
  await page.getByRole('button', { name: 'Answer the call' }).click();
  await page.getByRole('button', { name: 'How to play' }).waitFor({ timeout: 25_000 });
  if (!publicAudition) await page.evaluate(async () => {
    const { gameController } = await import('/src/game/session.ts');
    window.__auditionActions = [];
    gameController.subscribe(event => { if (event.type === 'action_queued') window.__auditionActions.push(event.action); });
  });
  const snapshot = async instruction => {
    const phone = page.getByTestId('phone');
    const cameraMode = await phone.getAttribute('data-camera-mode');
    const facing = await phone.getAttribute('data-grandma-facing');
    assert.ok(facing !== null && facing.trim() !== '', 'The rendered phone does not expose Grandma’s facing.');
    const grandmaFacingDegrees = Number(facing);
    assert.ok(cameraMode === 'selfie' || cameraMode === 'rear', 'The rendered phone does not expose its selected lens.');
    assert.ok(Number.isFinite(grandmaFacingDegrees), 'The rendered phone does not expose Grandma’s facing.');
    stateEvidence.push({ instruction, cameraMode, grandmaFacingDegrees });
  };
  await snapshot('Call ready');
  const tell = async (text, lens) => {
    const count = await page.getByRole('log').locator('p.grandma').count();
    await page.getByLabel('Tell Grandma what to do').fill(text);
    await page.getByRole('button', { name: 'Send instruction' }).click();
    if (lens) await page.locator(`[data-camera-mode="${lens}"]`).waitFor({ timeout: 15_000 });
    await page.waitForFunction(previous => document.querySelectorAll('[role="log"] p.grandma').length > previous, count, { timeout: 15_000 });
    await page.waitForTimeout(3500);
  };
  await tell('Turn off selfie mode.', 'rear');
  await snapshot('Turn off selfie mode.');
  const originalFacing = await page.getByTestId('phone').getAttribute('data-grandma-facing');
  await tell('Turn yourself around, your whole body.');
  await page.waitForFunction(previous => document.querySelector('[data-testid="phone"]')?.getAttribute('data-grandma-facing') !== previous, originalFacing, { timeout: 15_000 });
  const turnedFacing = await page.getByTestId('phone').getAttribute('data-grandma-facing');
  await snapshot('Turn yourself around, your whole body.');
  await tell('No, the camera, not you. I want to see your face again.', 'selfie');
  assert.equal(await page.getByTestId('phone').getAttribute('data-grandma-facing'), turnedFacing);
  await snapshot('No, the camera, not you. I want to see your face again.');
  await tell('Turn the camera around.', 'rear');
  assert.equal(await page.getByTestId('phone').getAttribute('data-grandma-facing'), turnedFacing);
  await snapshot('Turn the camera around.');
  // Finish capturing the last short reply without letting a session run unattended.
  await page.waitForTimeout(4000);
  const recording = await page.evaluate(async () => {
    await new Promise(resolve => { window.__voiceRecorder.onstop = resolve; window.__voiceRecorder.stop(); });
    return Array.from(new Uint8Array(await new Blob(window.__voiceChunks, { type: 'audio/webm' }).arrayBuffer()));
  });
  assert.ok(recording.length > 4000, 'The native audio recording is empty.');
  assert.equal(await page.evaluate(() => window.__microphoneRequests), 0, 'Typed AI must not ask for a microphone.');
  assert.deepEqual(errors, [], 'Browser errors');
  const transcript = await page.getByRole('log').innerText();
  const actions = publicAudition ? undefined : await page.evaluate(() => window.__auditionActions);
  await writeFile(`${artifact}.webm`, Buffer.from(recording));
  await page.screenshot({ path: `${artifact}.png`, animations: 'disabled' });
  const evidence = { url, publicAudition, durationSeconds: Math.round((Date.now() - started) / 1000), microphoneRequests: 0, nativeAudioBytes: recording.length, transcript, actions, stateEvidence, busyCheck, errors };
  const report = await saveAuditionReport(`${artifact}.json`, evidence, endCall);
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await page.screenshot({ path: `${artifact}-failure.png` }).catch(() => {});
  console.error('Voice status:', await page.locator('.connection-note').allTextContents().catch(() => []));
  console.error('Transcript:', await page.getByRole('log').innerText().catch(() => 'Not started'));
  throw error;
} finally {
  clearTimeout(timeout);
  try { await endCall(); } catch { console.error('Realtime call closure was not confirmed; inspect server call state before another audition.'); }
  await within(browser.close(), 5000, 'Browser shutdown deadline.');
}
