import { createHash } from "node:crypto";
import type { Plugin } from "vite";

const CSS_REQUEST = /\.css(?:$|\?)/;

export function cssDependencyChunkHash(): Plugin {
  const stylesheets = new Map<string, string>();
  let fingerprint: string | null = null;

  return {
    name: "omnyo:css-dependency-chunk-hash",
    apply: "build",
    buildStart() {
      stylesheets.clear();
      fingerprint = null;
    },
    transform: {
      filter: { id: CSS_REQUEST },
      handler(code, id) {
        stylesheets.set(id, code);
        fingerprint = null;

        return null;
      },
    },
    augmentChunkHash(chunk) {
      if (chunk.dynamicImports.length === 0 || stylesheets.size === 0)
        return undefined;

      if (fingerprint === null) {
        const hash = createHash("sha256");

        for (const id of [...stylesheets.keys()].sort()) {
          hash.update(id);
          hash.update("\0");
          hash.update(stylesheets.get(id) ?? "");
          hash.update("\0");
        }

        fingerprint = hash.digest("hex");
      }

      return fingerprint;
    },
  };
}
