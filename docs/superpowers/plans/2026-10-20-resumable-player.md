# Resumable Read Aloud Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Ship the approved seekable, resumable message player without holding UI HTTP requests open during synthesis.

**Architecture:** Bounded backend synthesis jobs/cache; a testable frontend reading-session state machine; a DOM player mounted through the existing trusted content script. Keep legacy RPC and local-engine behavior compatible.

**Tech Stack:** Existing TypeScript/BB SDK, native node:test, Web Audio; jsdom is a development-only dependency for DOM tests.

**Spec:** `docs/superpowers/specs/2026-10-20-resumable-player-design.md` (approved user behavior; implementation choices recorded separately).

## Global Constraints

- Preserve model/voice/rate and existing settings/secrets through supported plugin update.
- No private message/audio content in published source; no secret-derived identifiers/logs.
- No BB server restart, no edits to installed bundles, no new BB agent threads.
- Keep API calls bounded and preserve successful bytes/position after failure.

## Review Focus

- A stalled prefetch must not lose position or produce an unhandled rejection.
- Pause/seek during pending decode or network must not start stale audio afterwards.
- Resume must use identical bytes rather than timestamps from another synthesis.
- A future seek and incomplete duration estimates must remain navigable and marked approximate.
- Disposal, cache pressure and provider errors must not create unbounded jobs or timers.

## Task 1: Background synthesis and cache

Files: create `speech-jobs.ts`, `test/speech-jobs.test.ts`; modify `server.ts`.
Interface: `SpeechJobs.request(key, synthesize(signal)) -> jobId`; `status(jobId) -> {state,audio,message}`. New typed RPC `requestChunk` accepts the existing chunk/threadId/format plus optional retryJobId; `chunkStatus` accepts jobId. Existing RPC remain unchanged.

- [ ] Write failing tests: immediate pending, dedup, ready cache, failure/retry, two-worker bound, eviction and abort on dispose.
- [ ] Run native test file and verify RED, implement bounded store and background budgets, run GREEN.
- [ ] Test RPC prepare remains fast without format; delayed synthesis does not delay requestChunk; chunkStatus returns real audio or error. Run full suite/typecheck.

## Task 2: Seekable session state

Files: create `reading-session.ts`, `test/reading-session.test.ts`; modify `playback.ts` for decoding/duration and playing an existing AudioBuffer.
Interface: session `play()`, `pause()`, `seek(seconds)`, `skip(delta)`, `snapshot()`, `subscribe(listener)`, `dispose()`. Dependencies inject synthesis, decode and playback so tests control all races.

- [ ] RED tests for pause while pending, stale decode after seek, exact-byte reuse, late failure/resume, seek to unknown audio, ±15 clamping and total-duration correction.
- [ ] Implement chunk audio/duration cache and generation token; clear playback reference before advancing to next chunk; retain state after errors.
- [ ] Run focused and complete native tests; retain old playback tests.

## Task 3: Player controls and app wiring

Files: create `player-view.ts`, `test/player-view.test.ts`; modify `app.tsx`.
Interface: `mountPlayer(anchor, session)` creates accessible Play/Pause, ±15, range and status, returning disposal. Async client calls requestChunk then short chunkStatus polling. Capture Play user gesture before any await. Use content-script DOM mount under the action-slot wrapper; clean up and remount when its virtualized message returns.

- [ ] RED DOM tests for event wiring, range keyboard/change, error continuation label, approximate duration, sizing and cleanup.
- [ ] Implement panel and session registry; replace old Reading orchestration, retain settings and microphone pause behavior. Native backend errors appear inside retained panel.
- [ ] Full `npm run check`; visual/hit-test at390/820/1280; injected delayed/failing job on isolated test surface, not user server.

## Task 4: Release and live acceptance

- [ ] Self-review the complete diff against spec; verify no unrelated/private changes.
- [ ] Bump manifest/lock, build and test exact candidate; nonforce publish versioned source through the existing release route and verify refs.
- [ ] Supported `bb plugin update read-aloud --yes`; read back exact activated version and unchanged nonsecret settings.
- [ ] Long ROOT answer using new jobs: all parts return actual audio; decode all. Test actual player seek/pause/resume with a local fixture and real Web Audio. Shut down temporary QA surfaces.
- [ ] Record receipts and short owner report, distinguishing physical-device verification and the separate STT readiness issue.
