import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, rm, lstat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const voices = ['marin', 'coral', 'ballad'];
const models = [
  { id: 'gpt-realtime-2.1-mini', label: 'Mini' },
  { id: 'gpt-realtime-2.1', label: 'Full' },
];
const hash = bytes => createHash('sha256').update(bytes).digest('hex').slice(0, 12);
const escape = text => text.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const title = voice => voice[0].toUpperCase() + voice.slice(1);

async function manifestAt(directory) {
  try { return { directory, manifest: JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8')) }; }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

/** Only complete, explicitly listed six-clip sets can become a public static page. */
export async function buildAuditions({ rootDirectory = root, sourceDirectory, outputDirectory = path.join(rootDirectory, 'dist') } = {}) {
  const source = sourceDirectory ? await manifestAt(sourceDirectory)
    : await manifestAt(path.join(rootDirectory, 'auditions')) ?? await manifestAt(path.join(rootDirectory, 'artifacts/voice-comparison'));
  const pageDirectory = path.join(outputDirectory, 'auditions');
  const assetDirectory = path.join(outputDirectory, 'assets/auditions');
  if (!source) {
    await rm(pageDirectory, { recursive: true, force: true });
    await rm(assetDirectory, { recursive: true, force: true });
    return { skipped: true, reason: 'No audition manifest is present.' };
  }
  const { manifest } = source;
  if (typeof manifest.script !== 'string' || !manifest.script.trim() || manifest.script.length > 5000 || manifest.speed !== 1 || !Array.isArray(manifest.clips) || manifest.clips.length !== 6) {
    throw new Error('Auditions require one shared script, speed: 1, and six MP3 clips.');
  }
  const sourceRoot = await realpath(source.directory);
  const pairs = new Map();
  const filenames = new Set();
  const recordings = [];
  for (const clip of manifest.clips) {
    if (!voices.includes(clip.voice) || !models.some(model => model.id === clip.model) || (clip.speed !== undefined && clip.speed !== 1)) throw new Error('An audition voice, model, or speed is invalid.');
    const pair = `${clip.voice}:${clip.model}`;
    if (pairs.has(pair)) throw new Error('Each voice/model combination must appear exactly once.');
    if (typeof clip.mp3 !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]*\.mp3$/.test(clip.mp3) || clip.mp3.split('/').includes('..')) throw new Error('Auditions accept only relative MP3 paths within their source directory.');
    const filename = path.join(sourceRoot, clip.mp3);
    const resolved = await realpath(filename);
    const relative = path.relative(sourceRoot, resolved);
    if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || (await lstat(filename)).isSymbolicLink() || filenames.has(resolved)) throw new Error('Each audition must be a separate MP3 inside its source directory.');
    const bytes = await readFile(resolved);
    if (bytes.length < 128 || !(bytes.subarray(0, 3).toString('ascii') === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0))) throw new Error('An audition file is not a complete MP3 recording.');
    const tier = clip.model === models[0].id ? 'mini' : 'full';
    const outputName = `${clip.voice}-${tier}-${hash(bytes)}.mp3`;
    const recording = { voice: clip.voice, model: clip.model, outputName, bytes };
    filenames.add(resolved); pairs.set(pair, recording); recordings.push(recording);
  }
  for (const voice of voices) for (const model of models) if (!pairs.has(`${voice}:${model.id}`)) throw new Error('The six-clip audition set is incomplete.');

  const css = await readFile(new URL('./auditions.css', import.meta.url));
  const cssName = `auditions-${hash(css)}.css`;
  const cards = voices.map(voice => `<section class="card voice-card" aria-labelledby="${voice}">
      <h2 id="${voice}">${title(voice)}</h2>
      ${models.map(model => {
        const recording = pairs.get(`${voice}:${model.id}`);
        return `<div class="clip"><h3>${model.label}</h3><audio controls preload="none" aria-label="${title(voice)} · ${model.label}"><source src="/assets/auditions/${recording.outputName}" type="audio/mpeg">Your browser does not support audio playback.</audio></div>`;
      }).join('\n      ')}
    </section>`).join('\n    ');
  const html = `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta name="theme-color" content="#141917"><meta name="description" content="Compare three Grandma voices, each with Mini and Full, using the same lines at normal speed."><link rel="icon" href="data:,"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Google+Sans:wght@400;500;700&family=Caveat+Brush&display=swap" rel="stylesheet"><link rel="stylesheet" href="/assets/auditions/${cssName}"><title>Grandma voice auditions · Save Grandma</title></head>
<body><main>
  <a class="back-link" href="/">← Back to Save Grandma</a>
  <header class="page-header"><span class="eyebrow">SAVE GRANDMA</span><h1>Grandma voice auditions</h1><p>Three voices. The same lines. Normal speed.</p></header>
  <div class="voice-grid">${cards}</div>
  <section class="card script-card" aria-labelledby="shared-script"><h2 id="shared-script">The shared script</h2><blockquote>${escape(manifest.script.trim())}</blockquote></section>
  <p class="note">A simpler Brooklyn direction, played at normal speed (1.0×). These are AI-generated voice samples.</p>
</main><script>document.addEventListener('play',event=>{if(event.target instanceof HTMLAudioElement)document.querySelectorAll('audio').forEach(audio=>{if(audio!==event.target)audio.pause()})},true);</script></body></html>\n`;
  // Validate and load all six recordings before replacing any generated page or clip.
  await rm(pageDirectory, { recursive: true, force: true });
  await rm(assetDirectory, { recursive: true, force: true });
  await mkdir(assetDirectory, { recursive: true });
  await Promise.all(recordings.map(recording => writeFile(path.join(assetDirectory, recording.outputName), recording.bytes)));
  await writeFile(path.join(assetDirectory, cssName), css);
  await mkdir(pageDirectory, { recursive: true });
  await writeFile(path.join(pageDirectory, 'index.html'), html);
  return { skipped: false, clips: 6, source: path.relative(await realpath(rootDirectory), sourceRoot), page: 'dist/auditions/index.html' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.log(JSON.stringify(await buildAuditions()));
}
