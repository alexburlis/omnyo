import { access, constants } from "node:fs/promises";
import { homedir, release } from "node:os";
import { join } from "node:path";

const modelsRoot = join(homedir(), "Library", "Application Support", "FluidAudio", "Models");

const speechModelFiles = [
  "Preprocessor.mlmodelc",
  "Encoder.mlmodelc",
  "Decoder.mlmodelc",
  "JointDecision.mlmodelc",
  "parakeet_vocab.json",
].map((name) => join(modelsRoot, "parakeet-tdt-0.6b-v2", name));

const dictionaryModelFiles = ["MelSpectrogram.mlmodelc", "AudioEncoder.mlmodelc", "vocab.json"].map(
  (name) => join(modelsRoot, "parakeet-ctc-110m-coreml", name),
);

export type LocalEnvironment = {
  problem: string | null;
  speechModel: boolean;
  dictionaryModel: boolean;
};

async function usable(path: string, mode = constants.R_OK): Promise<boolean> {
  try {
    await access(path, mode);

    return true;
  } catch {
    return false;
  }
}

async function allPresent(paths: string[]): Promise<boolean> {
  return (await Promise.all(paths.map((path) => usable(path)))).every(Boolean);
}

async function environmentProblem(helper: string): Promise<string | null> {
  if (process.platform !== "darwin") return "Dictation by Paraspeech needs Omnyo running on a Mac.";

  if (process.arch !== "arm64") return "Dictation by Paraspeech needs a Mac with Apple silicon.";

  if (Number(release().split(".")[0]) < 23)
    return "Dictation by Paraspeech needs macOS 14 or later.";

  if (!(await usable(helper, constants.X_OK)))
    return "Dictation by Paraspeech is missing its speech helper. Reinstall the plugin.";

  return null;
}

export async function inspectEnvironment(helper: string): Promise<LocalEnvironment> {
  const [problem, speechModel, dictionaryModel] = await Promise.all([
    environmentProblem(helper),
    allPresent(speechModelFiles),
    allPresent(dictionaryModelFiles),
  ]);

  return { problem, speechModel, dictionaryModel };
}
