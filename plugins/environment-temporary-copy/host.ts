import { rm } from "node:fs/promises";
import { join } from "node:path";
import { experimental_defineHostEntry } from "@omnyo/plugin-sdk/host";
import { temporaryCopyHostContract } from "./contract.js";
import {
  appendChunk,
  applyCopyBack,
  applyOriginPack,
  confirmCopyBack,
  copiesRoot,
  copyExists,
  listCopyRefs,
  listSideRefShas,
  materializeCopy,
  prepareOriginCheckout,
  readChunk,
  readOriginCheckout,
  recordUnsavedWork,
  relayRoot,
  removeCopy,
  removeOriginCheckout,
  requireCopyPath,
  resolveBaseCommit,
  sweepRelay,
  writeCopyBackPack,
  writeOriginPack,
  writeSnapshotPack,
} from "./host/copy.js";

const STALE_RELAY_MS = 24 * 60 * 60 * 1000;

function relayFile(dataDir: string, snapshotId: string): string {
  return join(relayRoot(dataDir), `${snapshotId}.pack`);
}

export default experimental_defineHostEntry({
  contract: temporaryCopyHostContract,
  handlers: {
    async createSnapshot(input, context) {
      const dataDir = context.experimental_paths.dataDir;
      await sweepRelay(dataDir, STALE_RELAY_MS, Date.now());
      const commit = await resolveBaseCommit(input.sourcePath, input.branch);

      const digest = await writeSnapshotPack({
        sourcePath: input.sourcePath,
        commit,
        packFile: relayFile(dataDir, input.snapshotId),
      });

      return { commit, ...digest };
    },
    readRelay(input, context) {
      return readChunk(
        relayFile(context.experimental_paths.dataDir, input.snapshotId),
        input.offset,
        input.length,
      );
    },
    async appendRelay(input, context) {
      await appendChunk({
        file: relayFile(context.experimental_paths.dataDir, input.snapshotId),
        offset: input.offset,
        dataBase64: input.dataBase64,
        sha256: input.sha256,
      });

      return { ok: true as const };
    },
    async deleteRelay(input, context) {
      await rm(
        relayFile(context.experimental_paths.dataDir, input.snapshotId),
        {
          force: true,
        },
      );

      return { ok: true as const };
    },
    async materialize(input, context) {
      const dataDir = context.experimental_paths.dataDir;
      await sweepRelay(dataDir, STALE_RELAY_MS, Date.now());
      const path = join(copiesRoot(dataDir), input.pathKey);
      requireCopyPath(dataDir, path);

      await materializeCopy({
        packFile: relayFile(dataDir, input.snapshotId),
        digest: { size: input.size, sha256: input.sha256 },
        copyPath: path,
        branch: input.branch,
        baseRef: input.baseRef,
        baseCommit: input.baseCommit,
      });

      return { path };
    },
    async prepareCopyBack(input, context) {
      const dataDir = context.experimental_paths.dataDir;
      requireCopyPath(dataDir, input.path);
      await sweepRelay(dataDir, STALE_RELAY_MS, Date.now());

      const unsaved = input.recordUnsaved
        ? await recordUnsavedWork(input.path)
        : null;

      const refs = await listCopyRefs(
        input.path,
        input.baseRef,
        input.baseCommit,
      );

      const digest = await writeCopyBackPack({
        copyPath: input.path,
        baseCommit: input.baseCommit,
        refs,
        haves: input.haves,
        packFile: relayFile(dataDir, input.snapshotId),
      });

      return { refs, unsaved, ...digest };
    },
    prepareOriginCheckout(input, context) {
      return prepareOriginCheckout({
        dataDir: context.experimental_paths.dataDir,
        sourcePath: input.sourcePath,
        threadId: input.threadId,
        head: input.head,
        unsaved: input.unsaved,
      });
    },
    readOriginCheckout(input, context) {
      return readOriginCheckout({
        dataDir: context.experimental_paths.dataDir,
        sourcePath: input.sourcePath,
        threadId: input.threadId,
        base: input.base,
      });
    },
    writeOriginPack(input, context) {
      return writeOriginPack({
        sourcePath: input.sourcePath,
        tip: input.tip,
        base: input.base,
        packFile: relayFile(
          context.experimental_paths.dataDir,
          input.snapshotId,
        ),
      });
    },
    applyOriginPack(input, context) {
      const dataDir = context.experimental_paths.dataDir;
      requireCopyPath(dataDir, input.path);

      return applyOriginPack({
        copyPath: input.path,
        packFile: relayFile(dataDir, input.snapshotId),
        digest: { size: input.size, sha256: input.sha256 },
        tip: input.tip,
        expectedHead: input.expectedHead,
      });
    },
    removeOriginCheckout(input, context) {
      return removeOriginCheckout({
        dataDir: context.experimental_paths.dataDir,
        sourcePath: input.sourcePath,
        threadId: input.threadId,
      });
    },
    async listSideRefs(input) {
      return {
        shas: await listSideRefShas({
          sourcePath: input.sourcePath,
          threadId: input.threadId,
        }),
      };
    },
    async applyCopyBack(input, context) {
      const dataDir = context.experimental_paths.dataDir;
      await sweepRelay(dataDir, STALE_RELAY_MS, Date.now());

      return applyCopyBack({
        sourcePath: input.sourcePath,
        packFile: relayFile(dataDir, input.snapshotId),
        digest: { size: input.size, sha256: input.sha256 },
        threadId: input.threadId,
        branch: input.branch,
        baseCommit: input.baseCommit,
        refs: input.refs,
      });
    },
    async confirmCopyBack(input) {
      return {
        confirmed: await confirmCopyBack({
          sourcePath: input.sourcePath,
          threadId: input.threadId,
          baseCommit: input.baseCommit,
          refs: input.refs,
        }),
      };
    },
    async inspectCopy(input, context) {
      return {
        exists: await copyExists({
          dataDir: context.experimental_paths.dataDir,
          path: input.path,
        }),
      };
    },
    async removeCopy(input, context) {
      await removeCopy({
        dataDir: context.experimental_paths.dataDir,
        path: input.path,
      });

      return { ok: true as const };
    },
  },
});
