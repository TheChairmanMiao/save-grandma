# Validation

## Current local checks

On 2026-11-04, **170 tests passed**, TypeScript passed, and the hosted Worker build passed. Tests cover deterministic simulation, command sessions, parser and offline character recovery, tools, voice lifecycle, embedded assets, and the durable API admission gate. The Worker contains 10 client assets and compresses to approximately 3.81 MB.

Coverage includes the wrench solution, five-minute flooding, bounded towels/bucket, wrong rotations, tools, posture, reach, hands, blocked paths, seeded ambiguity, precise qualifiers, clarification, phone placement/retrieval, reference frames, sequencing, cancellation, pause/resume, reset, stale requests and terminal outcomes. Typed-command regressions verify that “tighten the pipe” seals the red pipe counterclockwise while an explicit clockwise instruction worsens the leak.

The command-session tests exercise fail-fast sequencing, duplicate deliveries, stale turns, abort/reset/dispose, synchronous cancellation races and pause/resume. Presentation tests exercise opposing phone lenses, fixed shelf cameras, continuous bend/turn/look motion and animation state. These are code-level checks rather than proof of live voice quality or device performance.

Voice lifecycle tests cover typed native audio without microphone permission, input switching and VAD configuration, single-send response creation, explicit speaker muting, same-origin relay selection, server close on page exit, busy/daily-limit messages, duplicate connects, timeouts, stale streams/events, provider disconnects, session expiry and cancellation. SDK/media resources are mocked; real browser behavior remains a separate check.

Eighteen backend tests execute actual SQLite queries with mocked provider HTTP. They verify atomic admission under 20 simultaneous starts, 10 reservations per UTC day, midnight rollover, one-use tokens, hashed storage, owner/origin/SDP validation, close during connection, stale close protection, expiry cleanup, upstream timeout/failure handling and fail-closed uncertainty. Seven embedded-asset tests cover byte preservation, caching, routing and security headers.

## Local Chrome browser check

The actual UI was checked in Chrome against the local development server and the final production preview on 2026-11-04. The production run completed the typed wrench solution, restarted into a second call, switched cameras with Enter and Send, and displayed a rotation clarification. It also reopened help with the flood paused, confirmed typed input remains available after the former speaking deadline, checked a 390×844 viewport for overflow, and verified that an intro completed while hidden immediately pauses the simulation. It reported no browser errors or requests to paid voice endpoints. Screenshots and the report are in the ignored `artifacts/` directory.

The updated offline production smoke also passed camera negation/toggling, body/camera correction and varied repeated dialogue. A local embedded-Worker Chrome check at 390×844 passed with bootstrap deliberately blocked: the fallback remained usable, rear-camera instructions worked, no overflow appeared, and no paid provider call occurred.

A separate 44-second live local OpenAI audition returned 632,031 bytes of native audio from typed messages, with zero microphone requests and no browser errors. It performed rear lens, body half-turn, selfie correction and rear lens flip in sequence. Ignored `artifacts/grandma-native-audition.*` contains the real recording, transcript, screenshot and action evidence. This proves the tested native playback and actions, not a consistent accent, perceived age or comic performance.

The exact local key was absent from tracked files, 210 reachable source/configuration Git blobs up to 2 MiB, and the built Worker/manifest. `.env.local` is ignored. The production configuration tool confirmed `OPENAI_API_KEY` as a secret with a redacted value. `scripts/check-key-safety.mjs` repeats local comparisons without logging the key.

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
