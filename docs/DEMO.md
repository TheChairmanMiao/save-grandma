# Shareable demo

This development copy starts from `gibumkang/help-me-grandma`, commit `90fed364eadff4753c5a53e0f49c0827f57c295d`. Original source history and team credits are retained. The working branch is `codex/shareable-demo`; the upstream GitHub repository is not changed by publishing through Sites.

## Player experience

The browser demo works with typed instructions, with no microphone, account, or paid API call required. Enter or the Send button submits an instruction. Typed play has no speaking countdown; a new instruction interrupts unfinished actions. How to play pauses the flood while the player reads the rules. Leaving the tab also pauses the game. Win/loss screens offer a fresh run.

The current game's visuals and UI are the design reference, as confirmed by Jeffrey for this demo. Images retain Jeff Miao's contribution records in `public/images/LICENSE.txt` and `downloads/LICENSE.txt`.

Title music, water, alarm, and incoming-call tones are original procedural sounds in `src/view/demo-audio.ts`. The supplied recordings remain in source for reference and are not used or copied into the build. Only imported image assets ship; the large unrigged GLBs also remain outside the deployed build.

## Development

Use the Node version in `.nvmrc`, run `npm ci`, then `npm run dev`. `npm run check` checks TypeScript and game regressions. `npm run build` creates `dist/`. With the dev server running, `npm run smoke` checks a full Chrome typed repair, restart, camera changes, clarification, help/pause, desktop and narrow layouts.

## Voice

Jeffrey selected OpenAI Realtime alone with typed fallback for the first voice audition. Local voice becomes available when your own `OPENAI_API_KEY` from `.env.example` is configured before starting Vite. OpenAI generates native speech; there is no ElevenLabs proxy or key configuration. Secrets must never use a `VITE_` prefix or enter the browser bundle. SDK code loads only when connecting voice. A voice failure leaves typed play available.

`src/voice/persona.ts` defines an original ornery Brooklyn grandmother with affectionate impatience, dry humor, a lightly gravelly lower-middle register, and clear, brisk pronunciation. The agent, opening line and terminal response overrides share that direction. The built-in voice remains `marin`, at speed 1.1. Browser speech for offline scripted lines is a local fallback, not a matching Realtime voice preview. The requested accent and perceived age require a listening test after the key is configured.

The static public build intentionally has no paid voice endpoints or credentials. Live voice on a public site still needs a production `/api/realtime-token` route, an operator-approved usage budget and access/issuance controls. The Vite development/preview middleware is not a production voice service. The six-minute client connection limit handles normal call cleanup; it does not enforce a spending cap. Live provider audio requires a separate end-to-end test after that setup.

## Publishing

`.openai/hosting.json` identifies the Sites deployment and declares `dist/` as static output. The public typed preview is https://save-grandma-demo.resoluteflame.chatgpt.site. Its first published version passed a full unauthenticated Chrome typed playthrough, replay, camera, clarification and help/pause checks on 2026-11-04.

The sibling `site-source/` folder is the publishing checkout. It retains its own Sites source history and excludes oversized reference GLBs, because the hosting service limits individual Git objects to 32 MiB. Keep the full development repository and assets here in `demo/`; synchronize verified source and its matching build to `site-source/` while preserving that checkout's Git history, `SOURCE.md` provenance and Site identity. Run the Sites publishing workflow from `site-source/`, not from the original upstream history. The upstream GitHub repository is not pushed by this workflow.
