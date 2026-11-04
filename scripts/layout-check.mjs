import { chromium } from 'playwright';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

// Real browser geometry checks. AI admission is intercepted even against a keyed dev server.
const url = process.env.LAYOUT_URL || process.env.SMOKE_URL || 'http://127.0.0.1:4173';
const channel = process.env.BROWSER_CHANNEL || 'chrome';
const output = 'artifacts/layout';
const matrix = [
  { name: 'desktop', width: 1440, height: 900, phone: false },
  { name: 'short-laptop', width: 1366, height: 650, phone: false },
  { name: 'landscape', width: 1024, height: 600, phone: false },
  { name: 'mobile', width: 390, height: 844, phone: true },
  { name: 'wide-mobile', width: 480, height: 800, phone: true },
];
const tolerance = 1.5;
const within = (inner, outer) => inner.x >= outer.x - tolerance && inner.y >= outer.y - tolerance
  && inner.x + inner.width <= outer.x + outer.width + tolerance
  && inner.y + inner.height <= outer.y + outer.height + tolerance;
const equalBounds = (a, b) => ['x', 'y', 'width', 'height'].every(key => Math.abs(a[key] - b[key]) <= tolerance);

await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel, headless: true });
const results = [];

async function checkViewport(viewport) {
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  const errors = [], bootstrap = [], unexpectedProviders = [], stages = [];
  let lastGeometry = null;
  await context.route('**/api/realtime-token', async route => {
    bootstrap.push(new URL(route.request().url()).pathname);
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Offline layout check: AI connection disabled.' }) });
  });
  await context.route('**/api/realtime-call', async route => {
    unexpectedProviders.push(new URL(route.request().url()).pathname);
    await route.abort();
  });
  await context.route(/^https:\/\/(api\.openai\.com|api\.elevenlabs\.io)\//, async route => {
    unexpectedProviders.push(new URL(route.request().url()).origin);
    await route.abort();
  });
  page.on('pageerror', error => errors.push(error.message));

  const bounds = async (locator, label) => {
    await locator.waitFor({ state: 'visible' });
    const box = await locator.boundingBox();
    assert.ok(box && box.width > 0 && box.height > 0, `${viewport.name}: ${label} has no visible bounds`);
    return box;
  };
  const controlFits = async (locator, phone, label) => {
    const box = await bounds(locator, label);
    assert.ok(within(box, phone), `${viewport.name}: ${label} is clipped by the phone viewport (${JSON.stringify(box)})`);
    const hittable = await locator.evaluate(element => {
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return !!hit && (hit === element || element.contains(hit));
    });
    assert.ok(hittable, `${viewport.name}: ${label} is covered or outside the screen`);
    return box;
  };
  const capture = async (stage, expectedPhone, content) => {
    const phone = await bounds(page.getByTestId('phone'), `${stage} phone`);
    const size = page.viewportSize();
    const screen = { x: 0, y: 0, width: size.width, height: size.height };
    const logical = await page.getByTestId('phone').evaluate(element => ({ width: element.clientWidth, height: element.clientHeight }));
    lastGeometry = { stage, phone, viewport: screen, logical };
    assert.ok(within(phone, screen), `${viewport.name}: ${stage} phone extends outside the browser`);
    if (size.width <= 520 && size.width < size.height) {
      assert.ok(equalBounds(phone, screen), `${viewport.name}: mobile phone should fill the screen`);
    } else {
      assert.ok(Math.abs(phone.width / phone.height - 9 / 16) < 0.002, `${viewport.name}: ${stage} phone is not 9:16`);
      assert.ok(Math.abs(logical.width - 390) <= tolerance && Math.abs(logical.height - 390 * 16 / 9) <= tolerance,
        `${viewport.name}: desktop changed the logical mobile layout size`);
      assert.ok(Math.abs(phone.x + phone.width / 2 - size.width / 2) <= tolerance, `${viewport.name}: phone is not horizontally centered`);
      assert.ok(Math.abs(phone.y + phone.height / 2 - size.height / 2) <= tolerance, `${viewport.name}: phone is not vertically centered`);
    }
    if (expectedPhone) assert.ok(equalBounds(phone, expectedPhone), `${viewport.name}: phone changed size or position during ${stage}`);
    const overflow = await page.evaluate(() => ({
      horizontal: document.documentElement.scrollWidth > innerWidth,
      vertical: document.documentElement.scrollHeight > innerHeight,
    }));
    assert.deepEqual(overflow, { horizontal: false, vertical: false }, `${viewport.name}: document overflows during ${stage}`);
    if (content) {
      const overlay = await bounds(content, `${stage} surface`);
      assert.ok(equalBounds(overlay, phone), `${viewport.name}: ${stage} surface does not share the phone viewport`);
    }
    await page.screenshot({ path: `${output}/${viewport.name}-${stage}.png` });
    const record = { stage, phone, viewport: screen, logical, overflow,
      controls: stage === 'game' ? {
        microphoneButton: await page.locator('button.mic').count() > 0,
        connectionMessages: await page.locator('.connection-note').allTextContents(),
      } : undefined,
    };
    stages.push(record);
    return phone;
  };
  const tell = async text => {
    const input = page.getByLabel('Tell Grandma what to do');
    await input.fill(text);
    await input.press('Enter');
  };
  try {
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    const title = page.locator('.start-screen');
    const initial = await capture('title', null, title);
    await controlFits(page.getByRole('button', { name: 'Start the game' }), initial, 'Start button');
    const titleImage = await bounds(page.getByRole('img', { name: 'Save Grandma', exact: true }), 'title image');
    assert.ok(within(titleImage, initial), `${viewport.name}: title artwork is clipped`);
    const artwork = await page.getByRole('img', { name: 'Save Grandma', exact: true }).evaluate(image => ({
      naturalRatio: image.naturalWidth / image.naturalHeight,
      displayedRatio: image.clientWidth / image.clientHeight,
    }));
    assert.ok(Math.abs(artwork.naturalRatio - artwork.displayedRatio) < 0.02, `${viewport.name}: title image box crops or distorts the artwork`);
    const caption = await bounds(page.locator('.demo-caption'), 'title caption');
    assert.ok(within(caption, initial), `${viewport.name}: title caption is clipped`);

    await page.getByRole('button', { name: 'Start the game' }).click();
    const incoming = page.getByRole('dialog', { name: 'Incoming call from Granny' });
    await incoming.waitFor();
    const ringing = await capture('incoming', initial, incoming);
    await controlFits(page.getByRole('button', { name: 'Answer the call' }), ringing, 'Answer button');
    const answerLabel = await bounds(page.getByRole('button', { name: 'Answer the call' }).locator('span'), 'Answer label');
    assert.ok(within(answerLabel, ringing), `${viewport.name}: Answer label is clipped`);

    await page.getByRole('button', { name: 'Answer the call' }).click();
    await page.getByRole('button', { name: 'How to play' }).waitFor({ timeout: 45000 });
    const input = page.getByLabel('Tell Grandma what to do');
    await input.waitFor();
    await tell('rear camera');
    await page.locator('[data-camera-mode="rear"]').waitFor();
    await tell('what even is this');
    await tell('what even is this');
    await input.fill('Look around');
    const playing = await capture('game', initial);
    await controlFits(input, playing, 'instruction input');
    await controlFits(page.getByRole('button', { name: 'Send instruction' }), playing, 'Send button');
    await controlFits(page.getByRole('button', { name: 'How to play' }), playing, 'Help button');
    assert.equal(await input.isEnabled(), true, `${viewport.name}: instruction input is disabled`);
    assert.equal(await page.getByRole('button', { name: 'Send instruction' }).isEnabled(), true, `${viewport.name}: Send button is disabled with text present`);
    const composer = await bounds(page.locator('.composer'), 'composer');
    assert.ok(within(composer, playing), `${viewport.name}: composer is clipped`);
    const controls = stages.find(item => item.stage === 'game').controls;
    if (controls.microphoneButton) {
      controls.microphoneBounds = await controlFits(page.locator('button.mic'), playing, 'microphone button');
    }
    controls.connectionBounds = [];
    for (const note of await page.locator('.connection-note').all()) {
      const noteBounds = await bounds(note, 'connection message');
      assert.ok(within(noteBounds, playing), `${viewport.name}: connection message is clipped`);
      controls.connectionBounds.push(noteBounds);
    }
    if (process.env.LAYOUT_MODE === 'hosted') {
      assert.equal(controls.microphoneButton, true, `${viewport.name}: hosted microphone control is missing`);
      assert.ok(bootstrap.length > 0 && controls.connectionMessages.length > 1,
        `${viewport.name}: hosted check must include the intercepted connection error row`);
    }
    await page.getByRole('button', { name: 'How to play' }).click();
    await page.getByRole('heading', { name: 'How to save Grandma' }).waitFor();
    const help = await capture('help', initial, page.locator('.call-overlay'));
    const card = await bounds(page.locator('.call-card'), 'help card');
    assert.ok(within(card, help), `${viewport.name}: help card is clipped`);
    await controlFits(page.getByRole('button', { name: 'Resume call' }), help, 'Resume button');
    await page.getByRole('button', { name: 'Resume call' }).click();

    if (viewport.name === 'desktop') {
      for (const size of [
        { name: 'portrait-resize', width: 900, height: 1440 },
        { name: 'landscape-resize', width: 1024, height: 600 },
        { name: 'mobile-resize', width: 390, height: 844 },
      ]) {
        await page.setViewportSize({ width: size.width, height: size.height });
        await page.waitForTimeout(300);
        const resized = await capture(size.name, null);
        await controlFits(input, resized, `${size.name} instruction input`);
        await controlFits(page.getByRole('button', { name: 'Send instruction' }), resized, `${size.name} Send button`);
        assert.equal(await input.inputValue(), 'Look around', 'Resizing must preserve the instruction draft');
      }
    }
    assert.deepEqual(unexpectedProviders, [], `${viewport.name}: unexpected AI connection attempt`);
    assert.deepEqual(errors, [], `${viewport.name}: browser errors`);
    await Promise.all([
      rm(`${output}/${viewport.name}-failure.png`, { force: true }),
      rm(`${output}/${viewport.name}-failure.json`, { force: true }),
    ]);
    return { ...viewport, stages, interceptedBootstrap: bootstrap.length, errors, paidCalls: 0 };
  } catch (error) {
    await page.screenshot({ path: `${output}/${viewport.name}-failure.png` }).catch(() => {});
    await writeFile(`${output}/${viewport.name}-failure.json`, JSON.stringify({ viewport, stages, lastGeometry, errors, interceptedBootstrap: bootstrap.length, failure: error.message }, null, 2));
    throw error;
  } finally {
    await context.close();
  }
}

try {
  for (const viewport of matrix) {
    const result = await checkViewport(viewport);
    results.push(result);
    console.log(`${viewport.name} ${viewport.width}×${viewport.height}: title, incoming call and gameplay fit; composer accessible`);
  }
  await writeFile(`${output}/report.json`, JSON.stringify({ url, buildMode: process.env.LAYOUT_MODE || 'unspecified', browser: browser.version(), checks: results, paidCalls: 0 }, null, 2));
  console.log(`Layout checks passed for ${results.length} viewports. Screenshots and report: ${output}/`);
} finally {
  await browser.close();
}
