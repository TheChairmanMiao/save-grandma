# Validation

## Current local checks

On 2026-11-04, **182 tests passed**, TypeScript passed, and the hosted Worker build passed. Tests cover deterministic simulation, command sessions, parser and offline character recovery, tools, voice lifecycle, embedded assets, audition publishing, audio byte ranges, and the durable API admission gate. The Worker contains 18 client assets and compresses to approximately 4.79 MB.

Coverage includes the wrench solution, five-minute flooding, bounded towels/bucket, wrong rotations, tools, posture, reach, hands, blocked paths, seeded ambiguity, precise qualifiers, clarification, phone placement/retrieval, reference frames, sequencing, cancellation, pause/resume, reset, stale requests and terminal outcomes. Typed-command regressions verify that “tighten the pipe” seals the red pipe counterclockwise while an explicit clockwise instruction worsens the leak.

The command-session tests exercise fail-fast sequencing, duplicate deliveries, stale turns, abort/reset/dispose, synchronous cancellation races and pause/resume. Presentation tests exercise opposing phone lenses, fixed shelf cameras, continuous bend/turn/look motion and animation state. These are code-level checks rather than proof of live voice quality or device performance.

Voice lifecycle tests cover typed native audio without microphone permission, input switching and VAD configuration, single-send response creation, explicit speaker muting, same-origin relay selection, server close on page exit, busy/daily-limit messages, duplicate connects, timeouts, stale streams/events, provider disconnects, session expiry and cancellation. SDK/media resources are mocked; real browser behavior remains a separate check.

Eighteen backend tests execute actual SQLite queries with mocked provider HTTP. They verify atomic admission under 20 simultaneous starts, 10 reservations per UTC day, midnight rollover, one-use tokens, hashed storage, owner/origin/SDP validation, close during connection, stale close protection, expiry cleanup, upstream timeout/failure handling and fail-closed uncertainty. Seven embedded-asset tests cover byte preservation, caching, routing and security headers.

## Local Chrome browser check

The actual UI was checked in Chrome against the local development server and the final production preview on 2026-11-04. The production run completed the typed wrench solution, restarted into a second call, switched cameras with Enter and Send, and displayed a rotation clarification. It also reopened help with the flood paused, confirmed typed input remains available after the former speaking deadline, checked a 390×844 viewport for overflow, and verified that an intro completed while hidden immediately pauses the simulation. It reported no browser errors or requests to paid voice endpoints. Screenshots and the report are in the ignored `artifacts/` directory.

The updated offline production smoke also passed camera negation/toggling, body/camera correction and varied repeated dialogue. A local embedded-Worker Chrome check at 390×844 passed with bootstrap deliberately blocked: the fallback remained usable, rear-camera instructions worked, no overflow appeared, and no paid provider call occurred.

A separate 44-second live local OpenAI audition returned 632,031 bytes of native audio from typed messages, with zero microphone requests and no browser errors. It performed rear lens, body half-turn, selfie correction and rear lens flip in sequence. Ignored `artifacts/grandma-native-audition.*` contains the real recording, transcript, screenshot and action evidence. This proves the tested native playback and actions, not a consistent accent, perceived age or comic performance.

The exact local key was absent from tracked files, 210 reachable source/configuration Git blobs up to 2 MiB, and the built Worker/manifest. `.env.local` is ignored. The production configuration tool confirmed `OPENAI_API_KEY` as a secret with a redacted value. `scripts/check-key-safety.mjs` repeats local comparisons without logging the key.

## Public voice and key checks

The hosted voice deployment was verified on 2026-11-04. A real call produced 620,349 bytes of native audio from typed messages, passed all four camera/body assertions, requested no microphone permission, and reported no browser page errors. A second isolated visitor received `409 BUSY`. The close endpoint returned a successful response; a separate status request confirmed the call was closed and nine daily reservations remained. The real recording is `artifacts/grandma-public-audition.mp3`; the evidence and limitation are recorded in `artifacts/grandma-public-verification.json`.

That first runner stalled after its game/audio assertions while awaiting Playwright's `Response.finished()` on the keepalive close request. It was stopped after confirming server closure independently. The harness now saves evidence before cleanup and bounds every cleanup wait; `node scripts/audition.mjs --check-cleanup` verifies the fix with mocks. No second paid call was used for that harness correction. This is not a claim that the first runner exited cleanly.

Public probes for `.env.local`, `.git/config` and server source returned 404 with no-store caching. GET on the token route returned 405; a cross-origin token POST returned 403. The post-commit key scan covered 90 tracked files, 249 reachable source/configuration blobs up to 2 MiB, and the built Worker/manifest, without printing the key.

## Normal-speed voice comparison

Six direct server-side Realtime sessions recorded the same 50-word script with Marin, Coral and Ballad on Mini and full Realtime. Every session acknowledged its requested model/voice, speed 1.0, low reasoning and 24 kHz mono PCM; every transcript matched the script. The recordings range from 17.55 to 24.10 seconds. Raw WAVs and sanitized usage receipts are in ignored `artifacts/voice-comparison/`; six MP3s and their manifest are tracked under `auditions/` for reproducible publication. They have no pitch, speed, or voice filtering applied.

The opt-in recorder limits each sample to 60 seconds and 1,500 output tokens, closes its socket, and reuses only matching completed samples. Its offline check exercises configuration acknowledgements, WAV validation, one-response behavior and sanitized usage without opening a network connection. An independent mocked timeout/error check verified forced socket teardown and omission of private provider error text. These auditions did not use the public demo's daily reservations.

The shared voice direction now favors natural delivery with light Brooklyn flavor, affectionate impatience and understated dry humor. Forced pitch/gravel/nasal/brisk cues were removed. Spoken game reactions are encouraged after the requested action or small prerequisite sequence instead of a separate narration for every intermediate step. Jeffrey chose Coral after listening to the comparison; the game uses Coral/Mini at speed 1.0. Listening quality remains the owner's creative judgment. The six original comparison recordings are preserved.

The comparison page passed Chrome checks for all six MP3s decoding, playing and seeking, one recording playing at a time, no audio download before playback, no API calls, correct byte-range responses and no browser errors. Desktop and 390×844 layouts were checked for overflow and readable content. The browser report and viewport screenshots are in `artifacts/voice-comparison/`. A full-page mobile screenshot showed a Chrome capture artifact; separate top/bottom viewport captures and DOM measurements confirmed the actual page has one heading, three voice cards and six players.

## Repeatable checks

```sh
npm run check
npm run build:offline
```

With an offline dev server (no configured key) running:

```sh
npm run smoke
BROWSER_CHANNEL=msedge npm run smoke
```

With `npm run preview:offline` running after an offline build:

```sh
SMOKE_URL=http://127.0.0.1:4173 SMOKE_PRODUCTION=1 npm run smoke
```

The smoke script requires the selected browser to be installed. It drives title/start/answer, typed camera switches, the wrench solution, restart, clarification, help/pause and the hidden-intro transition. It also checks the portrait frame, narrow-viewport overflow and the absence of paid endpoint calls. A successful local production-preview result is recorded above; public-host verification remains a publishing checkpoint.

## Remaining verification

- Complete the repair using a real microphone and configured Realtime service; confirm dialogue, tool execution, interruption, reconnect and reset.
- Review the saved native voice audition for intelligibility, Brooklyn pronunciation, affectionate irritation and brief panic. Test longer comic recovery and terminal dialogue separately.
- Run an explicit bounded public audition after deployment, including the busy gate and confirmed server hangup. Local middleware and provider mocks alone do not establish hosted behavior.
- Check actual mobile devices, Safari and Edge, including microphone permission denial, on-screen keyboard behavior and WebGL availability.
- Recheck phone placement/retrieval, action framing, water and terminal overlays in the rendered app after presentation changes.

The initial public typed preview at https://save-grandma-demo.resoluteflame.chatgpt.site passed a full unauthenticated Chrome playthrough, replay, camera, clarification, help/pause and hidden-intro checks on 2026-11-04, with no browser errors or paid voice endpoint requests. This verifies typed play, not hosted live voice.

The current scene has no occlusion-aware perception or general pathfinding. Room boundaries, the tool table and toilet have collision checks. The single-session game does not require saved games or multiplayer synchronization.
