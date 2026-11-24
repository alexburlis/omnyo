import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Command } from "commander";
import { webBuildSchema, type WebUpdateIdentity } from "@omnyo/server-contract";
import { action } from "../action.js";
import { createCliOmnyoSdk } from "../client.js";
import { outputJson } from "./helpers.js";

const replaceActiveDescription =
  "Exact active generation id, or packaged; only to remove your own live change or for an explicitly instructed replacement";

function expectedActiveGeneration(
  active: WebUpdateIdentity | null,
  replaceActive: string | undefined,
  refusal: (active: WebUpdateIdentity) => string,
) {
  if (replaceActive === undefined) {
    if (active !== null) throw new Error(refusal(active));

    return null;
  }

  if (replaceActive === "packaged") return null;

  if (!/^[a-f0-9]{64}$/u.test(replaceActive))
    throw new Error(
      "--replace-active takes the exact active generation id from `omnyo updates web status --json`, or packaged.",
    );

  return replaceActive;
}

export function registerWebUpdateCommands(
  updates: Command,
  getUrl: () => string,
) {
  const web = updates
    .command("web")
    .description(
      "Publish the compatible server-hosted interface without restarting Omnyo",
    );

  web
    .command("status", { isDefault: true })
    .option("--json", "Print JSON")
    .action(
      action(async (options: { json?: boolean }) => {
        const status =
          await createCliOmnyoSdk(getUrl()).system.webUpdateStatus();

        if (!outputJson(options, status))
          console.log(
            status.supported
              ? `Web updates available. Active: ${status.active?.sourceCommit ?? "packaged interface"}`
              : "A full Omnyo release is needed to enable web updates.",
          );
      }),
    );
  web
    .command("apply")
    .requiredOption("--directory <path>", "Verified app build directory")
    .option("--replace-active <generation>", replaceActiveDescription)
    .option("--json", "Print JSON")
    .action(
      action(
        async (options: {
          directory: string;
          json?: boolean;
          replaceActive?: string;
        }) => {
          const directory = resolve(options.directory);

          const build = webBuildSchema.parse(
            JSON.parse(
              await readFile(join(directory, "web-build.json"), "utf8"),
            ),
          );

          const id = createHash("sha256")
            .update(JSON.stringify(build))
            .digest("hex");

          const system = createCliOmnyoSdk(getUrl()).system;
          const status = await system.webUpdateStatus();

          if (status.active?.id === id) {
            if (!outputJson(options, status))
              console.log("This web build is already active.");

            return;
          }

          if (
            !status.supported ||
            status.compatibilityHash !== build.compatibilityHash
          )
            throw new Error("This change requires a full Omnyo release.");

          const expectedActive = expectedActiveGeneration(
            status.active,
            options.replaceActive,
            (active) =>
              `Web generation ${active.id} (source ${active.sourceCommit}) is active, and this command cannot check that the build contains it. Publish with pnpm private:web, or pass --replace-active ${active.id} only to remove your own live change or when you were explicitly told to replace it.`,
          );

          const { uploadId } = await system.webUpdateBegin({
            build,
            expectedActive,
          });

          console.error(
            `Web upload ${uploadId}: ${build.sourceCommit}, ${build.files.length} verified files.`,
          );

          try {
            const upload = async (file: (typeof build.files)[number]) => {
              const path = join(directory, file.path);
              const entry = await lstat(path);

              if (!entry.isFile() || entry.isSymbolicLink())
                throw new Error("Web builds require regular files.");
              const bytes = await readFile(path);

              if (
                bytes.length !== file.size ||
                createHash("sha256").update(bytes).digest("hex") !== file.sha256
              )
                throw new Error("Web build bytes changed after verification.");
              await system.webUpdateUpload({
                uploadId,
                path: file.path,
                content: bytes.toString("base64"),
              });
            };

            for (let index = 0; index < build.files.length; index += 4) {
              const results = await Promise.allSettled(
                build.files.slice(index, index + 4).map(upload),
              );

              const failure = results.find(
                (result) => result.status === "rejected",
              );

              if (failure?.status === "rejected") throw failure.reason;
            }

            const result = await system.webUpdateApply({
              uploadId,
              expectedActive,
            });

            if (!outputJson(options, result))
              console.log(
                "Web interface published. Reload the page when ready; running chats continue.",
              );
          } finally {
            await system.webUpdateAbort({ uploadId });
          }
        },
      ),
    );
  web
    .command("rollback")
    .option("--replace-active <generation>", replaceActiveDescription)
    .option("--json", "Print JSON")
    .action(
      action(async (options: { json?: boolean; replaceActive?: string }) => {
        const system = createCliOmnyoSdk(getUrl()).system;
        const status = await system.webUpdateStatus();

        const result = await system.webUpdateRollback({
          expectedActive: expectedActiveGeneration(
            status.active,
            options.replaceActive,
            (active) =>
              `Rollback removes active web generation ${active.id} (source ${active.sourceCommit}). Roll back only a generation you activated or were told to remove, and name it with --replace-active ${active.id}.`,
          ),
        });

        if (!outputJson(options, result))
          console.log(
            "Previous web interface restored. Reload the page when ready.",
          );
      }),
    );
}
