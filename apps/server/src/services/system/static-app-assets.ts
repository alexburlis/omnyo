import { createHash, randomUUID } from "node:crypto";
// oxlint-disable-next-line no-restricted-imports -- Owns generated server-local web assets, never workspace data.
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const generationsSchema = z.array(z.string().regex(/^[a-f0-9]{64}$/u)).max(3);

const missingFileSchema = z.object({ code: z.literal("ENOENT") });

export async function prepareStaticAppAssets({
  staticDir,
  dataDir,
}: {
  staticDir: string;
  dataDir: string;
}): Promise<string[]> {
  const generation = createHash("sha256")
    .update(await readFile(join(staticDir, "index.html")))
    .digest("hex");

  const root = join(dataDir, "web-asset-generations");
  const manifest = join(root, "generations.json");
  await mkdir(root, { recursive: true });
  let previous: string[];

  try {
    previous = generationsSchema.parse(
      JSON.parse(await readFile(manifest, "utf8")),
    );
  } catch (cause) {
    if (!missingFileSchema.safeParse(cause).success) throw cause;
    previous = [];
  }

  let complete = false;

  try {
    complete = (await stat(join(root, generation, "assets"))).isDirectory();
  } catch (cause) {
    if (!missingFileSchema.safeParse(cause).success) throw cause;
  }

  if (!complete) {
    const staging = await mkdtemp(join(root, ".stage-"));

    try {
      await cp(join(staticDir, "assets"), join(staging, "assets"), {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
      await rename(staging, join(root, generation));
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  const generations = [
    generation,
    ...previous.filter((id) => id !== generation),
  ].slice(0, 3);

  const pendingManifest = join(root, `.manifest-${randomUUID()}`);

  try {
    await writeFile(pendingManifest, JSON.stringify(generations));
    await rename(pendingManifest, manifest);
  } finally {
    await rm(pendingManifest, { force: true });
  }

  for (const expired of previous.filter((id) => !generations.includes(id))) {
    await rm(join(root, expired), { recursive: true, force: true });
  }

  return generations.map((id) => join(root, id));
}
