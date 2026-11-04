# Sites Worker hosting

The normal build first creates the existing Vite client, then runs `node hosting/build-worker.mjs`. The second step embeds those client bytes in one ESM Worker, bundles `server/public-api.ts`, and replaces `dist/` with `server/index.js` and `.openai/hosting.json`. This follows the Sites Worker ESM artifact contract without moving the React game into another framework. Source Drizzle migrations are included by the native Sites packager.

Keep the existing Site `project_id`, omit the hosting manifest's `static` field, and declare `d1: "DEMO_DB"`. Runtime secrets belong in Sites environment settings, never the manifest or build. Static asset responses preserve the client bytes and content types; the API runs before asset lookup. Unknown API paths return JSON 404 responses.

`node hosting/preview-worker.mjs` serves the generated Worker on `http://127.0.0.1:4173`. It applies the source migrations to a fresh in-memory SQLite database that implements the backend's D1 interface, and loads a local OpenAI key server-side through Vite's environment loader. Restarting this preview resets its quota database. It never accesses the hosted D1 database. Do not use this runner as the production quota service.

For browser tests that must stay offline, intercept the bootstrap endpoint before opening the page. The hosted client can otherwise request an AI admission when it starts. Static GETs and the status endpoint do not create provider sessions.
