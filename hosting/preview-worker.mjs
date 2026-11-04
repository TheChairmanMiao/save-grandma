import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadEnv } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--port')) throw new Error('Use preview-worker.mjs [--port <number>].');
const port = args.length ? Number(args[1]) : 4173;
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('The preview port is invalid.');
const origin = `http://127.0.0.1:${port}`;
const { default: worker } = await import(pathToFileURL(path.join(root, 'dist/server/index.js')).href);
if (typeof worker?.fetch !== 'function') throw new Error('Build the Worker before starting this preview.');

// This database belongs only to this preview process. It cannot access hosted D1 data.
const sqlite = new DatabaseSync(':memory:');
const migrationDirectory = path.join(root, 'drizzle');
const migrations = (await readdir(migrationDirectory)).filter(name => name.endsWith('.sql')).sort();
for (const name of migrations) sqlite.exec(await readFile(path.join(migrationDirectory, name), 'utf8'));
const database = {
  withSession() { return database; },
  prepare(sql) {
    const prepare = values => ({
      bind(...bound) { return prepare(bound); },
      async first() { return sqlite.prepare(sql).get(...values) ?? null; },
      async run() {
        const result = sqlite.prepare(sql).run(...values);
        return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
      },
    });
    return prepare([]);
  },
};
const local = loadEnv('development', root, '');
const env = { DEMO_DB: database, ...(local.OPENAI_API_KEY ? { OPENAI_API_KEY: local.OPENAI_API_KEY } : {}) };
const pending = new Set();
const context = {
  waitUntil(promise) {
    const job = Promise.resolve(promise).catch(() => { console.error('A preview background task failed.'); }).finally(() => pending.delete(job));
    pending.add(job);
  },
};

const server = createServer(async (incoming, outgoing) => {
  try {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of incoming) {
      bytes += chunk.length;
      if (bytes > 128 * 1024) {
        outgoing.writeHead(413, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        outgoing.end('Request too large');
        return;
      }
      chunks.push(chunk);
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
    const method = incoming.method ?? 'GET';
    const request = new Request(new URL(incoming.url ?? '/', origin), {
      method, headers, ...(method === 'GET' || method === 'HEAD' ? {} : { body: Buffer.concat(chunks) }),
    });
    const response = await worker.fetch(request, env, context);
    outgoing.statusCode = response.status;
    for (const [name, value] of response.headers) if (name !== 'set-cookie') outgoing.setHeader(name, value);
    const cookies = response.headers.getSetCookie();
    if (cookies.length) outgoing.setHeader('Set-Cookie', cookies);
    outgoing.end(method === 'HEAD' ? undefined : Buffer.from(await response.arrayBuffer()));
  } catch {
    console.error('The local Worker preview could not complete a request.');
    if (!outgoing.headersSent) outgoing.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    outgoing.end('Local preview error');
  }
});
server.on('error', error => { sqlite.close(); console.error(error.message); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => {
  console.log(`Worker preview: ${origin}`);
  console.log('Using a fresh local quota database; hosted D1 is unchanged.');
});
const shutdown = () => {
  server.close(async () => {
    await Promise.allSettled([...pending]);
    sqlite.close();
    process.exit(0);
  });
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
