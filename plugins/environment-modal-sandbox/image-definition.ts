import type { PluginApi } from "@omnyo/plugin-sdk";
import { z } from "zod";
import { readStandardDockerfile, readStandardImage } from "./standard-image.js";

export const dockerfileSchema = z.string().min(1).max(65_536);

const key = "dockerfile-override";

export function imageDefinition(api: Pick<PluginApi, "storage">) {
  return {
    async get() {
      const stored = await api.storage.kv.get<unknown>(key);

      return stored === undefined
        ? { dockerfile: await readStandardDockerfile(), customized: false }
        : { dockerfile: dockerfileSchema.parse(stored), customized: true };
    },
    async set(dockerfile: string) {
      const value = dockerfileSchema.parse(dockerfile);
      await readStandardImage(value);
      await api.storage.kv.set(key, value);

      return { dockerfile: value, customized: true };
    },
    async reset() {
      await api.storage.kv.delete(key);

      return { dockerfile: await readStandardDockerfile(), customized: false };
    },
  };
}

export type ImageDefinition = ReturnType<typeof imageDefinition>;
