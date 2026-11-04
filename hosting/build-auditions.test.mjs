import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildAuditions } from './build-auditions.mjs';

const temporary = [];
async function project() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'grandma-auditions-'));
  temporary.push(directory);
  await mkdir(path.join(directory, 'dist'), { recursive: true });
  await writeFile(path.join(directory, 'dist/index.html'), 'Existing game');
  return directory;
}
async function recordings(directory, script = 'Sweetheart, look at this mess. Tell me what to do, already!') {
  await mkdir(path.join(directory, 'audio'), { recursive: true });
  const clips = [];
  for (const voice of ['marin', 'coral', 'ballad']) for (const [tier, model] of [['mini', 'gpt-realtime-2.1-mini'], ['full', 'gpt-realtime-2.1']]) {
    const mp3 = `audio/${voice}-${tier}.mp3`;
    // Parser fixtures only; never played or placed in the real audition source/output.
    const bytes = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(160, clips.length)]);
    await writeFile(path.join(directory, mp3), bytes);
    clips.push({ voice, model, mp3 });
  }
  const manifest = { script, speed: 1, clips, privateMetadata: 'must-not-be-published' };
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(path.join(directory, 'audio/private-reference.wav'), 'Private reference');
  return manifest;
}
afterEach(async () => { await Promise.all(temporary.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

describe('static voice audition build', () => {
  it('skips absent manifests and preserves the game entry', async () => {
    const rootDirectory = await project();
    expect((await buildAuditions({ rootDirectory })).skipped).toBe(true);
    expect(await readFile(path.join(rootDirectory, 'dist/index.html'), 'utf8')).toBe('Existing game');
    await expect(readFile(path.join(rootDirectory, 'dist/auditions/index.html'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('publishes six hashed MP3s in voice cards with Mini before Full, excluding private metadata and WAV', async () => {
    const rootDirectory = await project();
    await recordings(path.join(rootDirectory, 'auditions'), 'A shared <script>example</script> & a clear line.');
    const result = await buildAuditions({ rootDirectory });
    expect(result).toMatchObject({ skipped: false, clips: 6, source: 'auditions' });
    const html = await readFile(path.join(rootDirectory, 'dist/auditions/index.html'), 'utf8');
    expect(html.match(/<audio /g)).toHaveLength(6);
    expect(html.match(/preload="none"/g)).toHaveLength(6);
    for (const voice of ['Marin', 'Coral', 'Ballad']) expect(html.indexOf(`${voice} · Mini`)).toBeLessThan(html.indexOf(`${voice} · Full`));
    expect(html).toContain('&lt;script&gt;example&lt;/script&gt; &amp;');
    expect(html).not.toContain('must-not-be-published');
    expect(html).not.toMatch(/fetch\(|\/api\//);
    const files = await readdir(path.join(rootDirectory, 'dist/assets/auditions'));
    expect(files.filter(name => name.endsWith('.mp3'))).toHaveLength(6);
    expect(files.every(name => /^(marin|coral|ballad)-(mini|full)-[a-f0-9]{12}\.mp3$/.test(name) || /^auditions-[a-f0-9]{12}\.css$/.test(name))).toBe(true);
  });
  it('prefers tracked source over ignored recordings and supports the artifact manifest for local use', async () => {
    const rootDirectory = await project();
    await recordings(path.join(rootDirectory, 'artifacts/voice-comparison'), 'Local artifact take.');
    expect((await buildAuditions({ rootDirectory })).source).toBe('artifacts/voice-comparison');
    await recordings(path.join(rootDirectory, 'auditions'), 'Tracked approved take.');
    expect((await buildAuditions({ rootDirectory })).source).toBe('auditions');
    expect(await readFile(path.join(rootDirectory, 'dist/auditions/index.html'), 'utf8')).toContain('Tracked approved take.');
  });
  it('fails closed for incomplete sets, duplicate pairs, wrong speed and paths outside the approved directory', async () => {
    for (const change of [
      manifest => manifest.clips.pop(),
      manifest => { manifest.clips[5] = { ...manifest.clips[0] }; },
      manifest => { manifest.speed = 1.25; },
      manifest => { manifest.clips[0].mp3 = '../outside.mp3'; },
    ]) {
      const rootDirectory = await project();
      const directory = path.join(rootDirectory, 'auditions');
      const manifest = await recordings(directory);
      change(manifest);
      await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
      await expect(buildAuditions({ rootDirectory })).rejects.toThrow();
      await expect(readFile(path.join(rootDirectory, 'dist/auditions/index.html'))).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });
  it('does not write a partial page if any listed MP3 is missing or is actually a WAV', async () => {
    for (const invalid of ['missing', 'wav']) {
      const rootDirectory = await project();
      const directory = path.join(rootDirectory, 'auditions');
      const manifest = await recordings(directory);
      const filename = path.join(directory, manifest.clips[5].mp3);
      if (invalid === 'missing') await rm(filename); else await writeFile(filename, Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(160)]));
      await expect(buildAuditions({ rootDirectory })).rejects.toThrow();
      await expect(readFile(path.join(rootDirectory, 'dist/auditions/index.html'))).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });
});
