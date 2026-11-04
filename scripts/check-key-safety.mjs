// Compare bytes locally. Never log the key or any matching source contents.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { loadEnv } from 'vite';

const key = loadEnv('development', process.cwd(), '').OPENAI_API_KEY;
if (!key) throw new Error('Configure the local OpenAI key before running this check.');
const needle = Buffer.from(key);
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
const tracked = git('ls-files', '-z').split('\0').filter(Boolean);
const failures = [];
if (tracked.includes('.env.local')) failures.push('The local settings file is tracked.');
try { git('check-ignore', '--quiet', '.env.local'); } catch { failures.push('The local settings file is not ignored.'); }
for (const filename of tracked) {
  try { if (readFileSync(filename).includes(needle)) failures.push(`Key found in tracked file: ${filename}`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const objects = git('rev-list', '--objects', '--all').trim().split('\n').map(line => line.split(' ')[0]);
const metadata = execFileSync('git', ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], { input: objects.join('\n') + '\n', encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
let historicalBlobs = 0;
for (const line of metadata.trim().split('\n')) {
  const [id, type, size] = line.split(' ');
  // Covers source/configuration blobs; large historical binary models are outside this check.
  if (type !== 'blob' || Number(size) > 2 * 1024 * 1024) continue;
  historicalBlobs++;
  const contents = execFileSync('git', ['cat-file', 'blob', id], { maxBuffer: 3 * 1024 * 1024 });
  if (contents.includes(needle)) failures.push('Key found in reachable Git history.');
}
let builtFiles = 0;
function scan(directory) {
  for (const filename of readdirSync(directory)) {
    const target = path.join(directory, filename);
    const info = statSync(target);
    if (info.isDirectory()) scan(target);
    else { builtFiles++; if (readFileSync(target).includes(needle)) failures.push(`Key found in build output: ${target}`); }
  }
}
scan('dist');
if (failures.length) { console.error(JSON.stringify({ passed: false, failures: [...new Set(failures)] })); process.exitCode = 1; }
else console.log(JSON.stringify({ passed: true, localSettingsIgnored: true, trackedFilesScanned: tracked.length, historicalSourceBlobsScanned: historicalBlobs, builtFilesScanned: builtFiles, keyPrinted: false }));
