import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const channel = process.env.BROWSER_CHANNEL || 'chrome';
const url = process.env.SMOKE_URL || 'http://127.0.0.1:5173';
const production = process.env.SMOKE_PRODUCTION === '1';
await mkdir('artifacts', { recursive: true });
const browser = await chromium.launch({ channel, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 1 });
const errors = [];
const providerRequests = [];
page.on('request', request => { if (/\/api\/(realtime-token|speak)/.test(request.url())) providerRequests.push(request.url()); });
page.on('pageerror', e => errors.push(e.message));
// Voice needs a microphone and OPENAI_API_KEY, neither of which the smoke environment has.
page.on('console', m => { if (m.type() === 'error' && !m.text().startsWith('[voice]')) errors.push(m.text()); });
page.on('requestfailed', r => errors.push(`${r.url()} ${r.failure()?.errorText}`));
const checks = [];
const tell = async (text, button = false) => { const input = page.getByLabel('Tell Grandma what to do'); await input.fill(text); if (button) await page.getByRole('button', { name: 'Send instruction' }).click(); else await input.press('Enter'); };
const connected = () => page.getByPlaceholder('Tell Grandma…').waitFor({ timeout: 40000 });
try {
  await page.emulateMedia({ reducedMotion: 'reduce' }); // the splash button wiggles forever otherwise
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.locator('canvas').waitFor();
  await page.screenshot({ path: `artifacts/${channel}-title.png` });
  await page.getByRole('button', { name: 'Start the game' }).click();
  await page.getByRole('dialog', { name: 'Incoming call from Granny' }).waitFor();
  await page.screenshot({ path: `artifacts/${channel}-incoming.png` });
  await page.getByRole('button', { name: 'Answer the call' }).click();
  await connected(); // Granny greets and the rules show before the call goes live
  assert.equal(await page.locator('canvas').count(), 1);
  const phone = await page.getByTestId('phone').boundingBox();
  assert.ok(Math.abs(phone.width / phone.height - 9 / 16) < 0.01, `Phone frame is not 9:16 (${phone.width}x${phone.height})`);
  await page.screenshot({ path: `artifacts/${channel}-rear.png` });
  checks.push('Title, incoming call, WebGL canvas, front camera, 9:16 frame');
  await page.getByRole('button', { name: 'How to play' }).click();
  await page.getByRole('heading', { name: 'How to save Grandma' }).waitFor();
  const pausedTime = await page.locator('.call-time').innerText();
  await page.waitForTimeout(600);
  assert.equal(await page.locator('.call-time').innerText(), pausedTime, 'Reading help should pause the flood');
  await page.getByRole('button', { name: 'Resume call' }).click();
  checks.push('Reopen help and resume without advancing the flood');
  await tell('switch to the front camera');
  await page.getByText('switch camera completed.', { exact: false }).waitFor();
  await page.screenshot({ path: `artifacts/${channel}-selfie.png` });
  await tell('switch to the rear camera', true);
  await page.getByText('switch camera completed.', { exact: false }).nth(1).waitFor();
  checks.push('Typed instruction switches camera');
  await page.waitForTimeout(11000);
  assert.equal(await page.getByLabel('Tell Grandma what to do').isEnabled(), true, 'Typed play must not expire after ten seconds');
  await tell('go to the toolboxes, open the red toolbox, open the blue toolbox, open the green toolbox, pick up the wrench, walk to the pipe, bend down, tighten the pipe');
  await page.getByRole('heading', { name: 'You did good, sweetheart. Don’t let it go to your head.' }).waitFor({ timeout: 60000 });
  await page.screenshot({ path: `artifacts/${channel}-wrench-win.png`, animations: 'disabled' });
  checks.push('Wrench solution typed through the command session');
  await page.getByRole('button', { name: 'Play again' }).click();
  // Play again may drop back to the title or straight into a new call; handle both.
  const start = page.getByRole('button', { name: 'Start the game' });
  await start.or(page.getByPlaceholder('Tell Grandma…')).first().waitFor({ timeout: 40000 });
  if (await start.isVisible()) { await start.click(); await page.getByRole('button', { name: 'Answer the call' }).click(); }
  await connected();
  await tell('go to the pipe, turn the pipe');
  await page.getByText('clockwise or counterclockwise', { exact: false }).waitFor({ timeout: 20000 });
  checks.push('Clarification result shown in transcript');
  checks.push('Restart and a second run');
  const timing = await page.evaluate(() => new Promise(resolve => {
    const deltas = []; let last = performance.now();
    function frame(now) { deltas.push(now - last); last = now; if (deltas.length < 120) requestAnimationFrame(frame); else { const sorted = deltas.slice(5).sort((a,b) => a-b); resolve({ medianFrameMs: sorted[Math.floor(sorted.length / 2)], p95FrameMs: sorted[Math.floor(sorted.length * .95)] }); } }
    requestAnimationFrame(frame);
  }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `artifacts/${channel}-mobile.png` });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Horizontal page overflow');
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Start the game' }).click();
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.getByRole('button', { name: 'Answer the call' }).click();
  await page.getByRole('heading', { name: 'Call paused.' }).waitFor({ timeout: 30000 });
  assert.match(await page.locator('.call-time').innerText(), /00:00/, 'An intro completed while hidden must not advance the flood');
  await page.evaluate(() => { Reflect.deleteProperty(document, 'hidden'); document.dispatchEvent(new Event('visibilitychange')); });
  await page.getByRole('button', { name: 'Resume call' }).click();
  checks.push('Intro finishing while hidden pauses immediately; return and resume');
  assert.deepEqual(providerRequests, [], 'Credential-free typed play must not contact paid voice endpoints');
  assert.deepEqual(errors, [], 'Browser errors');
  const report = { channel, browserVersion: browser.version(), url, production, checks, timing, errors };
  await writeFile(`artifacts/${channel}${production ? '-production' : ''}-report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await page.screenshot({ path: `artifacts/${channel}-failure.png` }).catch(() => {});
  console.error('Transcript at failure:', await page.getByRole('log').innerText().catch(() => '(none)'));
  throw error;
} finally { await browser.close(); }
