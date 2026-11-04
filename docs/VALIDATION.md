# Validation

## Current local checks

On 2026-11-04, **100 tests passed**, TypeScript passed, and Vite produced the production build. These checks verify deterministic simulation, command-session behavior, typed parsing, voice-tool execution, voice connection/playback lifecycle and the presentation contract. They do not verify a live provider conversation.

Coverage includes the wrench solution, five-minute flooding, bounded towels/bucket, wrong rotations, tools, posture, reach, hands, blocked paths, seeded ambiguity, precise qualifiers, clarification, phone placement/retrieval, reference frames, sequencing, cancellation, pause/resume, reset, stale requests and terminal outcomes. Typed-command regressions verify that “tighten the pipe” seals the red pipe counterclockwise while an explicit clockwise instruction worsens the leak.

The command-session tests exercise fail-fast sequencing, duplicate deliveries, stale turns, abort/reset/dispose, synchronous cancellation races and pause/resume. Presentation tests exercise opposing phone lenses, fixed shelf cameras, continuous bend/turn/look motion and animation state. These are code-level checks rather than proof of live voice quality or device performance.

Nineteen offline voice tests cover token failure before microphone access, duplicate connects, connection timeouts, late streams after retry/unmount, stale SDK events, provider disconnects, normal session expiry, output interruption, cancellation settlement, and audio cache cleanup. SDK/media resources are mocked; hook tests use a minimal harness, so real browser permissions and live provider playback remain separate checks.

## Local Chrome browser check

The actual UI was checked in Chrome against the local development server and the final production preview on 2026-11-04. The production run completed the typed wrench solution, restarted into a second call, switched cameras with Enter and Send, and displayed a rotation clarification. It also reopened help with the flood paused, confirmed typed input remains available after the former speaking deadline, checked a 390×844 viewport for overflow, and verified that an intro completed while hidden immediately pauses the simulation. It reported no browser errors or requests to paid voice endpoints. Screenshots and the report are in the ignored `artifacts/` directory.

These results cover typed play in desktop Chrome, including the production build served locally. They do not establish live microphone/provider behavior, Edge or Safari compatibility, actual mobile device behavior, production-hosted API behavior, or a public deployment.

## Repeatable checks

```sh
npm run check
npm run build
```

With `npm run dev` running:

```sh
npm run smoke
BROWSER_CHANNEL=msedge npm run smoke
```

With `npm run preview` running after a production build:

```sh
SMOKE_URL=http://127.0.0.1:4173 SMOKE_PRODUCTION=1 npm run smoke
```

The smoke script requires the selected browser to be installed. It drives title/start/answer, typed camera switches, the wrench solution, restart, clarification, help/pause and the hidden-intro transition. It also checks the portrait frame, narrow-viewport overflow and the absence of paid endpoint calls. A successful local production-preview result is recorded above; public-host verification remains a publishing checkpoint.

## Remaining verification

- Complete the repair using a real microphone and configured Realtime service; confirm dialogue, tool execution, interruption, reconnect and reset.
- When ElevenLabs is enabled, confirm streamed speech, fallback behavior and immediate silence on interruption.
- Verify the deployed server routes with server-side credentials before claiming hosted voice works. Local Vite middleware alone does not establish a production backend.
- Check actual mobile devices, Safari and Edge, including microphone permission denial, on-screen keyboard behavior and WebGL availability.
- Recheck phone placement/retrieval, action framing, water and terminal overlays in the rendered app after presentation changes.

The current scene has no occlusion-aware perception or general pathfinding. Room boundaries, the tool table and toilet have collision checks. The single-session game does not require saved games or multiplayer synchronization. No public deployment has been verified in this validation record.
