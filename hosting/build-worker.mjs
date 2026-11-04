import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { build } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = path.join(root, 'dist');
const hostingPath = path.join(root, '.openai/hosting.json');
const hosting = JSON.parse(await readFile(hostingPath, 'utf8'));
if (!hosting.project_id || hosting.static != null || hosting.d1 !== 'DEMO_DB') {
  throw new Error('Worker hosting requires the existing project_id, no static field, and d1: DEMO_DB.');
}

const contentTypes = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
  '.wav': 'audio/wav', '.wasm': 'application/wasm',
};
const textExtensions = new Set(['.html', '.js', '.css', '.json', '.svg']);
const assets = {};
let clientBytes = 0;
async function collect(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name.startsWith('.') || (directory === dist && entry.name === 'server')) continue;
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) { await collect(filename); continue; }
    if (!entry.isFile()) throw new Error('Client output must contain only regular files and directories.');
    const key = `/${path.relative(dist, filename).split(path.sep).join('/')}`;
    const bytes = await readFile(filename);
    const extension = path.extname(filename).toLowerCase();
    const encoding = textExtensions.has(extension) ? 'utf8' : 'base64';
    assets[key] = {
      contentType: contentTypes[extension] ?? 'application/octet-stream', byteLength: bytes.length,
      etag: `"${createHash('sha256').update(bytes).digest('hex')}"`,
      encoding, body: bytes.toString(encoding),
    };
    clientBytes += bytes.length;
  }
}
await collect(dist);
if (!assets['/index.html'] || !Object.keys(assets).some(name => name.startsWith('/assets/'))) {
  throw new Error('Build the Vite client first; dist/index.html and its assets are required.');
}

// A single ESM module follows the Sites Worker starter contract. Client bytes stay assets,
// rather than becoming executable server modules, and no provider secret is bundled.
const virtualId = '\0virtual:save-grandma-assets';
const result = await build({
  root, configFile: false, publicDir: false, logLevel: 'warn',
  plugins: [{
    name: 'save-grandma-embedded-assets',
    resolveId(id) { if (id === 'virtual:save-grandma-assets') return virtualId; },
    load(id) { if (id === virtualId) return `export default ${JSON.stringify(assets)};`; },
  }],
  build: {
    write: false, emptyOutDir: false, minify: 'esbuild', target: 'es2022', sourcemap: false,
    lib: { entry: path.join(root, 'hosting/worker.ts'), formats: ['es'], fileName: () => 'index.js' },
    rollupOptions: { external: ['cloudflare:workers'], output: { inlineDynamicImports: true } },
  },
});
const outputs = (Array.isArray(result) ? result : [result]).flatMap(item => item.output ?? []);
if (outputs.length !== 1 || outputs[0].type !== 'chunk') throw new Error('The Sites Worker must build to one self-contained ESM module.');
const worker = outputs[0].code;
const workerBytes = Buffer.byteLength(worker);
const workerGzipBytes = gzipSync(worker).length;
if (workerGzipBytes > 10 * 1024 * 1024) throw new Error('The embedded Worker exceeds the 10 MiB compressed build budget.');

// Replace client output only after its Worker has built successfully. Sites receives exactly
// the Worker and manifest; the native packager adds the source-controlled Drizzle migrations.
await rm(dist, { recursive: true, force: true });
await mkdir(path.join(dist, 'server'), { recursive: true });
await mkdir(path.join(dist, '.openai'), { recursive: true });
await writeFile(path.join(dist, 'server/index.js'), worker);
await writeFile(path.join(dist, '.openai/hosting.json'), `${JSON.stringify(hosting, null, 2)}\n`);
console.log(JSON.stringify({ output: 'dist/server/index.js', assets: Object.keys(assets).length, clientBytes, workerBytes, workerGzipBytes }));
