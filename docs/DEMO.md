# Shareable demo

This development copy starts from `gibumkang/help-me-grandma`, commit `90fed364eadff4753c5a53e0f49c0827f57c295d`. Original source history and team credits are retained. The working branch is `codex/shareable-demo`; the upstream GitHub repository is not changed by publishing through Sites.

## Player experience

The browser demo accepts typed instructions without microphone access. When AI is available, typed messages receive native spoken replies; the mic button enables speech input in the same conversation. Scripted offline play remains available when AI cannot connect. Enter or Send submits an instruction. There is no speaking countdown; a new instruction interrupts unfinished actions. How to play pauses the flood while keeping the same AI call. Leaving the tab also pauses the game. Win/loss screens offer a fresh run.

The current game's visuals and UI are the design reference, as confirmed by Jeffrey for this demo. Images retain Jeff Miao's contribution records in `public/images/LICENSE.txt` and `downloads/LICENSE.txt`.

Title music, water, alarm, and incoming-call tones are original procedural sounds in `src/view/demo-audio.ts`. The supplied recordings remain in source for reference and are not used or copied into the build. Only imported image assets ship; the large unrigged GLBs also remain outside the deployed build.

## Development

Use the Node version in `.nvmrc`, run `npm ci`, then `npm run dev`. `npm run check` checks TypeScript and regressions. `npm run build` creates the hosted Worker in `dist/`; `npm run preview` runs it locally. For credential-free QA, use `npm run build:offline` and `npm run preview:offline`, then `SMOKE_URL=http://127.0.0.1:4173 SMOKE_PRODUCTION=1 npm run smoke`. Do not run the offline smoke script against a server with live AI enabled.

## Voice

Jeffrey selected OpenAI Realtime alone with typed fallback. Local AI becomes available when your own `OPENAI_API_KEY` from `.env.example` is configured before starting Vite. Typed messages and microphone speech share one Realtime agent and native spoken output. The call starts without asking for microphone access; the mic button enables it later. There are no forced speaking windows or automatic speaker muting. OpenAI generates native speech; there is no ElevenLabs proxy or key configuration. Secrets must never use a `VITE_` prefix or enter the browser bundle. SDK code loads only when connecting. A connection failure leaves scripted typed play available.

`src/voice/persona.ts` defines an original ornery Brooklyn grandmother with affectionate impatience, dry, understated humor and natural delivery with a light regional flavor. The agent, opening line and terminal response overrides share that direction. Playback is normal speed (1.0). The forced pitch/gravel/nasal/brisk direction has been removed. The game remains on `marin` and Mini while the comparison is reviewed.

`/auditions` presents the same scripted lines in Marin, Coral and Ballad, each on `gpt-realtime-2.1-mini` and `gpt-realtime-2.1`. These recordings compare voice performance, not live gameplay or tool accuracy. The MP3 files and sanitized manifest are retained under `auditions/` for reproducible builds; raw WAV files and usage receipts stay in ignored `artifacts/voice-comparison/`. Playing the comparison recordings makes no AI calls. A successful action test does not establish the requested accent, perceived age or character performance.

When AI is unavailable, `OfflineGrandma` supplies explicitly labeled scripted dialogue and browser speech. It remembers attempted visible targets and corrections within each run, varies repeated responses, and can work out reported posture/reach prerequisites on a repeated request. Both modes distinguish lens flips from body turns. Offline speech depends on the browser's installed voices and can sound synthetic.

The hosted API in `server/public-api.ts` enforces the owner-selected limit of 10 reservations per UTC day and one globally active call through a singleton D1 row. Reservations, including unsuccessful connection attempts, consume the daily allowance. Busy rejections do not. The browser receives a single-use application token, then submits its WebRTC offer to the same-origin relay; the reusable provider key and call ID stay on the server. Closing the call requests a provider hangup before releasing the active slot.

The browser closes ordinary calls after six minutes and on leaving the page. The server checks expired leases on subsequent API requests and refuses new admissions until the prior provider call is confirmed closed. There is no background wall-clock scheduler. An ambiguous upstream create or failed hangup deliberately keeps the slot blocked; investigate server logs and provider call state before clearing it. These controls bound admissions, not dollar spending or adversarial use within an admitted call.

Only one API credential is required: `OPENAI_API_KEY`. Set it in local `.env.local` for development, and separately as a secret in the existing Site's production environment for hosting. The same key covers Realtime speech and input transcription. Local key changes do not automatically update the hosted secret. No ElevenLabs or Fish Audio credentials are used.

## Publishing

`.openai/hosting.json` preserves the existing Sites identity and declares the `DEMO_DB` D1 binding. `hosting/build-worker.mjs` embeds the unchanged Vite HTML, scripts, styles and image bytes into a single Worker module; no source assets or credentials are copied into the browser. The public URL is https://save-grandma-demo.resoluteflame.chatgpt.site. Its first offline version passed a full unauthenticated Chrome typed playthrough, replay, camera, clarification and help/pause checks on 2026-11-04. Each voice deployment also needs an explicit, bounded public audition.

The sibling `site-source/` folder is the publishing checkout. It retains its own Sites source history and excludes oversized reference GLBs, because the hosting service limits individual Git objects to 32 MiB. Keep the full development repository and assets here in `demo/`; synchronize verified source and its matching build to `site-source/` while preserving that checkout's Git history, `SOURCE.md` provenance and Site identity. Run the Sites publishing workflow from `site-source/`, not from the original upstream history. The upstream GitHub repository is not pushed by this workflow.
