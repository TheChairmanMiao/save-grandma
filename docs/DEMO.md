# Shareable demo

This development copy starts from `gibumkang/help-me-grandma`, commit `90fed364eadff4753c5a53e0f49c0827f57c295d`. Original source history and team credits are retained. The working branch is `codex/shareable-demo`; the upstream GitHub repository is not changed by publishing through Sites.

## Player experience

The browser demo works with typed instructions, with no microphone, account, or paid API call required. Enter or the Send button submits an instruction. Typed play has no speaking countdown; a new instruction interrupts unfinished actions. How to play pauses the flood while the player reads the rules. Leaving the tab also pauses the game. Win/loss screens offer a fresh run.

The current game's visuals and UI are the design reference, as confirmed by Jeffrey for this demo. Images retain Jeff Miao's contribution records in `public/images/LICENSE.txt` and `downloads/LICENSE.txt`.

Title music, water, alarm, and incoming-call tones are original procedural sounds in `src/view/demo-audio.ts`. The supplied recordings remain in source for reference and are not used or copied into the build. Only imported image assets ship; the large unrigged GLBs also remain outside the deployed build.

## Development

Use the Node version in `.nvmrc`, run `npm ci`, then `npm run dev`. `npm run check` checks TypeScript and game regressions. `npm run build` creates `dist/`. With the dev server running, `npm run smoke` checks a full Chrome typed repair, restart, camera changes, clarification, help/pause, desktop and narrow layouts.

## Voice

The existing OpenAI Realtime / optional ElevenLabs implementation is retained. Local voice becomes available when server-side credentials from `.env.example` are configured before starting Vite. Secrets must never use a `VITE_` prefix or enter the browser bundle. SDK code loads only when connecting voice. A voice failure leaves typed play available.

The static public build intentionally has no paid voice endpoints or credentials. Live voice on a public site still needs production server routes, an operator-approved usage budget and access/issuance controls. The Vite development/preview middleware is not a production voice service. The six-minute client connection limit handles normal call cleanup; it does not enforce a spending cap. Live provider audio requires a separate end-to-end test after that setup.

## Publishing

`.openai/hosting.json` identifies the Sites deployment and declares `dist/` as static output. Publish the exact checked source/build through the Sites workflow. The saved Site URL can be linked from Jeffrey's portfolio; no change to that website is required.
