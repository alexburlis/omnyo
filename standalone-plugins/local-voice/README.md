# Dictation by Paraspeech for Omnyo

Dictation by Paraspeech transcribes Omnyo dictation on your Mac with the English Parakeet TDT 0.6B v2 model. Audio never leaves the Mac that runs Omnyo, and there is no cloud fallback.

## Requirements

Omnyo running on a Mac with Apple silicon and macOS 14 or later. Dictation by Paraspeech uses the Mac that runs the Omnyo server, whichever device you dictate from. Nothing else needs installing: the plugin ships its speech helper and Opus decoder, and converts other recording formats with macOS's built-in `afconvert`.

On other machines, the plugin reports why it is unavailable and stays out of the voice picker.

## Set up

1. Install the plugin and select it for voice input:

   ```sh
   omnyo plugin install <path-to-local-voice> --yes
   omnyo settings ai-services set voice local-voice
   ```

2. Open **Settings → Dictation** and click **Download model** under **Speech model**. One click downloads the English speech model and the dictionary model (about 550 MB together) into FluidAudio's shared cache at `~/Library/Application Support/FluidAudio/Models`, then loads the engine. Dictation is ready when the section says the model is downloaded. The plugin never starts this download on its own.

   From the CLI: `omnyo plugin rpc call local-voice download`, then `omnyo plugin rpc call local-voice status` until the state is `ready`. `omnyo plugin rpc call local-voice prepare` loads the downloaded model now.

3. Press **Control+D** in a chat composer to start recording, and again to stop and add the text to the draft. Change the shortcut in **Settings → Keyboard → Dictation by Paraspeech: Toggle recording**. The shortcut works while Omnyo is focused; it is not a system-wide hotkey.

## Custom dictionary

**Custom dictionary** starts empty. Add one name or phrase per line in the plugin's settings. The dictionary model comes with the one-click download and loads only while the dictionary has words. If it is missing when you add a word, Dictation by Paraspeech downloads it (about 100 MB).

## Behavior

- Omnyo asks Dictation by Paraspeech to load the model when you start recording and when the Mac running Omnyo connects, so the model is usually ready by the time you stop. On Omnyo versions without that request, the first dictation after a pause loads the model itself.
- The model still unloads five minutes after its last use, when Omnyo releases idle plugin workers, and after Omnyo restarts. A reload usually takes under three seconds. If a cleaner such as CleanMyMac, or a macOS update, deletes `~/Library/Caches/OmnyoLocalVoice` (Core ML's compiled copy of the model), the next load takes about 20 seconds while macOS rebuilds it.
- Cancelling a recording, or a recording that fails to transcribe, no longer unloads the model. Back-to-back dictations queue and run one at a time on the loaded model.
- Transcription fails visibly after 65 seconds, inside Omnyo's 70-second voice limit.
- Logs contain routes, timings and fixed reason codes, never audio, transcripts or dictionary terms. Each dictation records how long loading and decoding took, whether it had to start the model, and whether the compiled-model cache was missing. Request audio lives in a temporary directory that is removed after each transcription.

## Build

The plugin needs one native file, `native/OmnyoLocalVoice`, which is not in Git: build it before the plugin. `pnpm build:helper` compiles it from `helper/` (FluidAudio pinned at `93468021dcad336a8fda232e91dd61f616a20afd`) with the qualified pinned Swift compiler in a temporary folder, then `scripts/accept-helper.mjs` copies it into `native/` after checking its signature and that it contains no home-folder paths. `pnpm build:plugin` builds the plugin and copies that file into `dist/local-voice-native/`; prepared runtime packages run the same `scripts/stage-assets.mjs`. `pnpm build` runs both. Third-party licenses are in `NOTICE.md`.

The existing guarded compiler recovery owner may pass `--externally-network-fenced --resume-scratch PATH` only after it verifies the inherited outbound-network denial. This recovery-only mode forwards `-Xswiftc -Xfrontend -Xswiftc -disable-sandbox` so compiler subprocesses inherit the existing outer fence without requesting a nested sandbox; ordinary builds and dependency preparation keep their default compiler sandbox.

## Verify

```sh
omnyo plugin rpc call local-voice status --json
pnpm typecheck
pnpm lint
pnpm format:check
pnpm e2e
```

The three E2E cases drive Omnyo's microphone UI with real human recordings and real local inference: idle-cache eviction followed by cold and warm Control+D dictation, dictionary correction plus ordinary speech, and recording/caller cancellation that returns promptly and keeps the same helper loaded for a warm next dictation. The cancellation case also uploads a zeroed copy of the public recording to verify that an empty model result is reported as no returned text. The first case waits up to five and a half minutes for idle eviction. The suite needs Chrome and a downloaded model, restores the dictionary and voice selection, and writes `artifacts/e2e.json`.

Completion logs include encoded byte count, decoded duration and sample format, non-finite and clipped sample counts, an RMS level bucket, and the number of Opus decode errors. Sample counts are per channel; non-finite and clipped counts cover all decoded channels. RMS buckets are 0 for zero PCM, then 1–5 for levels up to 0.0001, 0.001, 0.01, 0.1 and above 0.1. These measure decoded audio, not whether speech was present. Unavailable measurements stay null. Valid partial Opus audio still reaches the model; its decode errors remain visible as a count. The logs contain no audio, transcript, dictionary terms or recording paths.
