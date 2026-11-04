# Save Grandma

A playable bathroom emergency for the Fishathon team. The player sees through Grandma’s phone and talks her through stopping a leak. Realtime voice tools execute instructions in the simulation; typed instructions provide a fallback when voice is unavailable.

The shareable build works with typed instructions and no microphone or API credentials. It retains the existing visual direction, adds pauseable help and a Send button, and uses original procedural audio. See [demo setup and publishing](docs/DEMO.md) for what ships and the remaining production voice setup.

## Run locally

Use Node 22.12+ (22 LTS or 24 LTS recommended).

```sh
npm ci
npm run dev
```

Voice: copy `.env.example` to `.env.local` and set `OPENAI_API_KEY`, then restart the dev server. Starting the call connects Grandma (`gpt-realtime-2.1-mini` over WebRTC via the OpenAI Agents SDK); allow microphone access and talk to her. The key stays in the local Vite server, which mints short-lived client secrets at `POST /api/realtime-token`. Optional `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID` settings route Grandma’s spoken lines through the server’s `POST /api/speak` proxy; otherwise Realtime supplies her live voice. Scripted fallback lines use browser speech synthesis. Voice code lives in `src/voice/`.

Open the printed localhost URL. The game is a portrait phone screen, as if you were video-calling Grandma. Press Start, answer her incoming call, and follow the turn prompts to speak. The mic button connects or retries voice and lets you finish or take a turn. When voice is unavailable, type instructions in the field at the bottom and press Enter during your turn. Typed text uses a small keyword matcher in `src/voice/text-commands.ts` and the `gameCommands` bridge; type `help` for example phrases. The call opens on the front camera, looking at Grandma; asking her to switch to the rear camera is part of the challenge. The quickest typed win is `switch to the rear camera, go to the toolboxes, open the red toolbox, open the blue toolbox, open the green toolbox, pick up the wrench, walk to the pipe, bend down, turn the pipe counterclockwise`. Typed `tighten the pipe` also seals the red pipe; an explicit `clockwise` instruction worsens the leak, including `tighten the pipe clockwise`. Compound lines split on commas, “then” and “and”, and stop at the first failed step.

- `npm test` — deterministic simulation and controller tests.
- `npm run check` — TypeScript and simulation tests.
- `npm run build` — checked production build in `dist/`.
- `npm run preview` — serve the production build locally.
- `npm run smoke` — Chrome browser scenarios against the running dev server (typed-instruction wrench solution, restart, camera switching, clarification, portrait frame).
- `BROWSER_CHANNEL=msedge npm run smoke` — the same tests in installed desktop Edge.
- `SMOKE_URL=http://127.0.0.1:4173 SMOKE_PRODUCTION=1 npm run smoke` — the same scenarios against the production build.

There is no developer console anymore; the scripted presets in `src/game/presets.ts` remain as test fixtures only. Restart is available from the end-of-call card. Switching away from the browser tab pauses the session; resume from the overlay when returning.

## What is implemented

- Sequential structured actions, phone selfie/rear cameras, Grandma-relative and camera-relative directions, procedural Grandma, room interactions, reaching, posture and hands.
- One solution: find the wrench in one of three toolboxes (the deal is seeded), carry it to the red pipe, bend down and turn it counterclockwise to seal it. The screwdriver and hammer are decoys.
- Five minutes to flooding with no intervention. One-use towels and bucket add at most 30 and 45 seconds at the initial leak rate; they cannot solve the leak.
- Seeded stress-dependent ambiguity (15/30/45%). Precise instructions have no random interpretation failures. Unclear targets/directions return structured clarification results.
- Cancellation at safe points, pause/resume, full reset, stale-run rejection, progress/results/terminal events and a bounded queue.
- Realtime microphone input, language interpretation and dialogue through the OpenAI Agents SDK; optional ElevenLabs speech output; typed fallback commands and a call transcript showing results, clarifications and misunderstandings.

## Team handoff

**Jeff owns creative assets and presentation. Yao owns voice AI.** The game layer owns simulation, action execution, phone behavior, and the integration contracts. [Team work areas and next integration steps](docs/TEAM.md).

| Owner | Entry point |
| --- | --- |
| Yao · Voice AI | [Integration guide](docs/INTEGRATION.md), `src/game/index.ts`, `gameCommands`, `ACTION_REQUEST_SCHEMA` |
| Jeff · Creative | [Creative handoff](docs/CREATIVE.md), `src/creative/visuals.ts`, `src/view/presentation.ts` |
| Game simulation | `src/game/controller.ts`, `src/game/config.ts` |
| Hackathon alignment | [Reviewed starter guidance](docs/HACKATHON.md) |
| Validation | [Checks and remaining browser verification](docs/VALIDATION.md) |

The source includes the OpenAI Agents SDK voice adapter, procedural 3D room and character components, title/caller images, original synthesized sounds, and Google Fonts loaded by `index.html`. Provider credentials are configured server-side and are not included. The public build exposes typed play; live voice is enabled only in local development with configured server credentials. Original audio recordings and raw GLBs remain in source but are excluded from the build. Live voice still needs separate verification.

The command-session bridge accepts structured actions and handles same-run interruptions, stale responses, duplicate delivery, and ordered sequences that stop at the first issue. Typed instructions use this bridge. The Realtime adapter exposes tools backed by the same game controller; its live interruption and audio behavior require voice-session verification. The simulation advances in fixed 50 ms steps, independent of browser frame rate.

The custom React 19 + React Three Fiber 9 setup follows the [renderer’s compatibility guidance](https://r3f.docs.pmnd.rs/getting-started/installation). This is a standalone app, outside the starter repo’s `game-kit/` folder. See the hackathon notes for why the starter’s folder-specific JavaScript engine rules do not require a stack change here.
