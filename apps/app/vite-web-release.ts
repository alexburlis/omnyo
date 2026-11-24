import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import type { IndexHtmlTransformContext, Plugin } from "vite";

type OutputBundle = NonNullable<IndexHtmlTransformContext["bundle"]>;

export function webBundleRelease(bundle: OutputBundle): string {
  const hash = createHash("sha256");

  const outputs = Object.values(bundle)
    .filter((output) => !output.fileName.endsWith(".html"))
    .sort((left, right) => left.fileName.localeCompare(right.fileName));

  for (const output of outputs) {
    hash.update(output.fileName);
    hash.update("\0");
    hash.update(output.type === "chunk" ? output.code : output.source);
    hash.update("\0");
  }

  return `web-${hash.digest("hex")}`;
}

export function webReleaseIdentity(sourceDirectory: string): Plugin {
  return {
    name: "omnyo-web-release-identity",
    transformIndexHtml: {
      order: "post",
      async handler(_html, context) {
        if (context.bundle === undefined) return [];

        const { stdout } = await promisify(execFile)(
          "git",
          ["rev-parse", "HEAD"],
          { cwd: sourceDirectory },
        );

        const sourceRevision = stdout.trim();

        if (!/^[a-f0-9]{40,64}$/.test(sourceRevision))
          throw new Error("Invalid web source revision");

        return [
          {
            tag: "meta",
            attrs: {
              name: "omnyo-web-release",
              content: webBundleRelease(context.bundle),
            },
            injectTo: "head",
          },
          {
            tag: "meta",
            attrs: { name: "omnyo-web-source", content: sourceRevision },
            injectTo: "head",
          },
        ];
      },
    },
  };
}
