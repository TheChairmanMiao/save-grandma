# Save Grandma

A playable bathroom emergency for the Fishathon team. The player sees through Grandma’s phone and talks her through stopping a leak. Realtime voice tools execute instructions in the simulation; typed instructions provide a fallback when voice is unavailable.

The hosted build supports OpenAI speech with typed or microphone input, with a shared limit of 10 call starts per UTC day and one active call. Scripted offline play remains available when AI is busy or unavailable. It retains the existing visual direction and uses original procedural audio. See [demo setup and publishing](docs/DEMO.md).

## Run locally

Use Node 22.13+ (22 LTS or 24 LTS recommended).

```sh
npm ci
npm run dev
```

Voice: copy `.env.example` to `.env.local` and set your own `OPENAI_API_KEY`, then restart the dev server. Starting the call connects Grandma (`gpt-realtime-2.1-mini` over WebRTC via the OpenAI Agents SDK). Typed messages go to the same agent and receive native spoken replies, without requesting microphone access. Tap the mic to talk instead; typing remains available. The key stays in the local Vite server, which mints short-lived client secrets at `POST /api/realtime-token`. No ElevenLabs key is needed. Voice code lives in `src/voice/`.

Open the printed localhost URL. The game is a portrait phone screen, as if you were video-calling Grandma. Press Start and answer her incoming call. You can type or interrupt at any point during the call; there is no speaking countdown. The speaker button mutes Grandma's replies independently of the mic.

When natural voice is unavailable, the interface explicitly shows “Offline dialogue · basic browser voice.” This scripted fallback uses `OfflineGrandma`, the parser in `src/voice/text-commands.ts` and the `gameCommands` bridge. It remembers corrections within a run, tries plausible visible targets for vague instructions, and reacts to actual action results. It is more limited than the live AI, and browser speech varies by device. Type `help` for example phrases.

The call opens on the front camera. “Turn off selfie mode” selects the rear lens; “turn the camera around” flips the current lens; “turn yourself around” turns Grandma's body. The offline wrench solution is `switch to the rear camera, go to the toolboxes, open the red toolbox, open the blue toolbox, open the green toolbox, pick up the wrench, walk to the pipe, bend down, turn the pipe counterclockwise`. Typed `tighten the pipe` also seals the red pipe; an explicit `clockwise` instruction worsens the leak, including `tighten the pipe clockwise`. Offline compound lines split on commas, “then” and “and”, and stop at the first failed step.

- `npm test` — deterministic simulation and controller tests.
- `npm run check` — TypeScript and simulation tests.
- `node scripts/check-key-safety.mjs` — checks local key exclusion without printing its value.
- `npm run build` — checked production build in `dist/`.
- `npm run build:offline` — static, credential-free fallback build for offline QA.
- `npm run preview` — serve the hosted Worker build locally, with a separate local database.
- `npm run smoke` — offline Chrome browser scenarios (wrench solution, replay, camera and body distinction, correction, varied dialogue, clarification, help/pause and portrait frame). Run with no key, or use the production preview command below.
- `BROWSER_CHANNEL=msedge npm run smoke` — the same tests in installed desktop Edge.
- `npm run preview:offline` after `npm run build:offline`, then `SMOKE_URL=http://127.0.0.1:4173 SMOKE_PRODUCTION=1 npm run smoke` — the same scenarios against the offline build.
- `LIVE_AUDITION=1 node scripts/audition.mjs` — opt-in paid local Realtime audition. Records native audio from typed input, checks camera/body actions and closes after at most 90 seconds. Requires the configured dev server; never points at a public host.

There is no developer console anymore; the scripted presets in `src/game/presets.ts` remain as test fixtures only. Restart is available from the end-of-call card. Switching away from the browser tab pauses the session; resume from the overlay when returning.

## What is implemented

- Sequential structured actions, phone selfie/rear cameras, Grandma-relative and camera-relative directions, procedural Grandma, room interactions, reaching, posture and hands.
- One solution: find the wrench in one of three toolboxes (the deal is seeded), carry it to the red pipe, bend down and turn it counterclockwise to seal it. The screwdriver and hammer are decoys.
- Five minutes to flooding with no intervention. One-use towels and bucket add at most 30 and 45 seconds at the initial leak rate; they cannot solve the leak.
- Seeded stress-dependent ambiguity (15/30/45%). Precise instructions have no random interpretation failures. Unclear targets/directions return structured clarification results.
- Cancellation at safe points, pause/resume, full reset, stale-run rejection, progress/results/terminal events and a bounded queue.
- Native OpenAI Realtime typed or microphone input, language interpretation and spoken dialogue; scripted offline fallback and a call transcript showing results, clarifications and misunderstandings.
- An original ornery Brooklyn grandma direction: affectionate exasperation, dry humor, regional pronunciation and brief bursts of panic. The shared direction in `src/voice/persona.ts` governs the agent, greeting and final spoken lines. The current audition uses the built-in `marin` voice at speed 1.1. A real local recording is available in ignored `artifacts/grandma-native-audition.mp3`; perceived age, accent and comic performance remain creative listening judgments.

## Team handoff

**Jeff owns creative assets and presentation. Yao owns voice AI.** The game layer owns simulation, action execution, phone behavior, and the integration contracts. [Team work areas and next integration steps](docs/TEAM.md).

| Owner | Entry point |
| --- | --- |
| Yao · Voice AI | [Integration guide](docs/INTEGRATION.md), `src/game/index.ts`, `gameCommands`, `ACTION_REQUEST_SCHEMA` |
| Jeff · Creative | [Creative handoff](docs/CREATIVE.md), `src/creative/visuals.ts`, `src/view/presentation.ts` |
| Game simulation | `src/game/controller.ts`, `src/game/config.ts` |
| Hackathon alignment | [Reviewed starter guidance](docs/HACKATHON.md) |
| Validation | [Checks and remaining browser verification](docs/VALIDATION.md) |

The source includes the OpenAI Agents SDK voice adapter, procedural 3D room and character components, title/caller images, original synthesized sounds, and Google Fonts loaded by `index.html`. Provider credentials stay server-side. The hosted API relays the initial WebRTC connection, retains the provider call ID, and uses durable database admission limits. Visitors receive a single-use application token instead of the OpenAI key. Original audio recordings and raw GLBs remain in source but are excluded from the build. Typed-to-native-speech and camera/body tools have passed a live local check; microphone/device checks remain separate.

The command-session bridge accepts structured actions and handles same-run interruptions, stale responses, duplicate delivery, and ordered sequences that stop at the first issue. Offline instructions use this bridge. The Realtime adapter exposes tools backed by the same game controller. The simulation advances in fixed 50 ms steps, independent of browser frame rate.

The custom React 19 + React Three Fiber 9 setup follows the [renderer’s compatibility guidance](https://r3f.docs.pmnd.rs/getting-started/installation). This is a standalone app, outside the starter repo’s `game-kit/` folder. See the hackathon notes for why the starter’s folder-specific JavaScript engine rules do not require a stack change here.
