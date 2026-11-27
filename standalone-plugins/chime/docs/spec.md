# Chime product specification

Chime is a private, locally maintained fork installed from its owned checkout. The external Chime plugin remains disabled; no external update source controls this plugin.

## Required behavior

1. Play calm, short, non-verbal sounds for visible AI turn starts and verified, settled completion. Recheck the same successful turn immediately before playback; read turns, queued sends, any sidebar activity, pending questions/approvals and unfinished native goals suppress completion. When Needs You is enabled, honor its green-highlight setting, callback waits, owned workflow workers and open Decisions. Background activity changes recheck a deferred completion without polling.
2. Play more prominent sounds when a thread waits for a user question, requests approval, or fails.
3. Detect manual cancellation from the latest manual-stop event. Missing history, non-manual interruptions and verification failures must not produce completion sounds.
4. Cover sidebar-visible threads by default, including ones not currently open. Hidden helper threads stay silent.
5. Make every event independently toggleable and allow a built-in sound to be selected per event. Turn started and turn cancelled are off by default; a saved setting that omits an event uses that default.
6. Provide Omnyo, Velvet, Calm, Glass, Wood, and Minimal theme presets, with Omnyo as the default. Selecting a preset applies all six coordinated sounds; changing an individual sound yields a Custom selection. Each sound appears once in the per-event picker, under the first theme that uses it; a theme may also list alternative sounds that appear only in its picker group.
7. Provide master enable and volume controls, visible-thread muting, project muting, and sound previews.
8. Treat project muting as a denylist: new projects are audible by default.
9. Coalesce notification storms within one second, with questions, approvals, and failures taking priority over routine sounds.
10. Discard events older than five seconds rather than replaying stale sounds after reconnect.

## Playback

1. Default to client-local playback in Omnyo desktop windows and browser/remote clients.
2. Elect one audible client per browser origin on a best-effort basis.
3. Surface browser autoplay activation state and provide an explicit enable/test action.
4. Offer optional server playback on macOS when `/usr/bin/afplay` is available; report it unavailable elsewhere.
5. Bundle small WAV files. Calm, Glass, Wood, and Minimal sounds are original and generated deterministically in the repository; the three Velvet sounds and the eleven Omnyo sounds were made for Omnyo by the project owner; the README records their sources and edits.

## Privacy and persistence

1. Notification payloads contain only event kind, thread/project identifiers, optional interaction ID, optional successful-turn event sequence for playback verification, and timestamp. Cursor and configuration data may accompany notifications in the transport envelope.
2. Do not include prompts, responses, or error text.
3. Do not send telemetry.
4. Persist only configuration and muted project IDs. Event queues and deduplication state remain short-lived and in memory.

## Delivery quality

1. Use the display name Chime, package name `omnyo-plugin-chime-local`, private package protection, distinct plugin ID `chime-local`, plugin-owned bell branding, and the MIT license.
2. Include backend and frontend unit tests, typechecking, a successful plugin build, local path installation, exact migrated settings, external Chime disabled, and live smoke tests.
3. Document browser autoplay, per-origin coordination, server playback location, and heuristic cancellation detection.
