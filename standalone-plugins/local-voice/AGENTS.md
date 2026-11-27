# Dictation by Paraspeech

Dictation by Paraspeech is fully local English dictation for anyone whose Omnyo server runs on an Apple silicon Mac. Never add a cloud route or upload audio. Preserve other projects and FluidAudio's shared model cache.

- `server.ts` targets the Mac running Omnyo (`system.config().primaryHostId`), owns download state, and exposes `status`, `download` and `prepare` RPCs. It answers the AI services picker from `environment.ts` alone: a host call there would renew the idle worker every few seconds and keep the model loaded forever.
- `environment.ts` checks the platform, the helper and the downloaded models in FluidAudio's cache. The server and host share it because the primary host is the server's own Mac.
- `app.tsx` renders the **Speech model** settings section with the download button and registers the composer-scoped Control+D recording toggle.
- `server.ts` registers `experimental_prepare`, which Omnyo calls when recording starts and when the Mac's daemon connects; it loads the model only when it is already downloaded and rejects otherwise, so Omnyo never logs a prepare that did not happen. The `prepare` RPC runs the same path. There is no start-up warm-up: it ran before the Mac connected. Older runtimes ignore the hook, so transcription still loads the model itself.
- `host.ts` downloads both models in one pass and owns the helper's lifetime: one shared boot per helper and dictionary, a FIFO queue with one decode in flight, a 60-second decode watchdog, and temporary audio cleanup. A caller's abort only detaches that caller; handlers must reject promptly, because the daemon kills a worker whose cancelled call outlives its 5-second grace. Failed recordings and helper `error` replies keep the helper loaded; it stops only when it exits, breaks the protocol, times out or the engine is disposed. A dictionary change reboots it after the in-flight decode. Its `status` reports only engine state.
- The model still unloads when the daemon stops the idle worker after five minutes. Never hold a worker lease to keep it loaded: a held lease blocks idle runtime and plugin updates.
- Logs carry prepare and decode times, whether the model had to start, and whether Core ML's compiled-model cache (`~/Library/Caches/<helper name>`) was missing. A cleaner deleting it costs one load of about 20 seconds.
- `audio.ts` turns recordings into 16 kHz mono WAV: WebM and Ogg Opus through the bundled `opus-decoder`, everything else through `/usr/bin/afconvert`. Never add an external tool such as ffmpeg.
- `helper/` pins FluidAudio at `93468021dcad336a8fda232e91dd61f616a20afd`; English v2 only, with optional English CTC dictionary scoring.
- One Download click must install every prerequisite. Models download only through that button or RPC, or when the user adds dictionary words and the dictionary model is missing. The dictionary default stays empty.
- Never hard-code a host ID, user path or Homebrew prefix. The server passes the helper path from its own package.
- Use pnpm. `pnpm build:helper` rebuilds the helper in temporary scratch and accepts it into the untracked `native/OmnyoLocalVoice`, refusing a binary that embeds a home-folder path. Never commit the helper binary: it embeds the build machine's temporary paths.
- Keep `NOTICE.md` current when a bundled dependency, the FluidAudio pin or a downloaded model changes.
- Test only the three real E2E cases in `e2e/voice.spec.ts`. No unit tests, mocked models, or production test seams.
- Run typecheck, lint, and format check. Logs must never contain audio, transcripts, dictionary terms, credentials, or raw failures.
