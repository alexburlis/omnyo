import { discoverProjectIcons } from "./project-icon-search.js";
import { parentPort, workerData } from "node:worker_threads";
import { enableInheritedProcessGroup } from "@omnyo/process-utils";
import { z } from "zod";
import {
  finalizeListedFiles,
  finalizeListedPaths,
  listWorkspacePaths,
  WORKSPACE_PATH_LIST_MAX_ENTRIES,
} from "./file-list.js";
import {
  fileSearchRequestSchema,
  type FileSearchRequest,
  type FileSearchResponse,
} from "./file-search-protocol.js";

const options = z
  .object({ inheritProcessGroup: z.boolean() })
  .parse(workerData);

if (options.inheritProcessGroup) enableInheritedProcessGroup();

async function search(request: FileSearchRequest) {
  if (request.discovery === "icons") {
    const icons = await discoverProjectIcons({
      root: request.root,
      excludeNames: request.excludeNames,
      limit: request.limit,
    });

    if (!request.query) return icons;

    const result = finalizeListedFiles({
      filePaths: icons.files.map((file) => file.path),
      query: request.query,
      limit: request.limit,
    });

    return { ...result, truncated: icons.truncated || result.truncated };
  }

  const listing = await listWorkspacePaths({
    root: request.root,
    includeFiles: request.includeFiles,
    includeDirectories: request.includeDirectories,
    includeHidden: request.includeHidden,
    excludeNames: request.excludeNames,
    respectGitIgnore: request.respectGitIgnore,
    maxEntries: WORKSPACE_PATH_LIST_MAX_ENTRIES,
  });

  const query = request.query ? { query: request.query } : {};

  const result =
    request.kind === "files"
      ? finalizeListedFiles({
          filePaths: listing.paths.map((entry) => entry.path),
          limit: request.limit,
          ...query,
        })
      : finalizeListedPaths({
          paths: listing.paths,
          limit: request.limit,
          includeFiles: request.includeFiles,
          includeDirectories: request.includeDirectories,
          ...query,
        });

  return { ...result, truncated: result.truncated || listing.truncated };
}

function failure(id: number, error: unknown): FileSearchResponse {
  const code =
    error instanceof Error && "code" in error && typeof error.code === "string"
      ? error.code
      : undefined;

  return {
    id,
    ok: false,
    error: {
      message: error instanceof Error ? error.message : String(error),
      ...(code !== undefined ? { code } : {}),
    },
  };
}

const port = parentPort;

if (port === null) {
  throw new Error("The file search worker must run in a worker thread");
}

port.on("message", (message: unknown) => {
  const request = fileSearchRequestSchema.parse(message);

  search(request).then(
    (result) => {
      const response: FileSearchResponse = {
        id: request.id,
        ok: true,
        result,
      };

      port.postMessage(response);
    },
    (error: unknown) => port.postMessage(failure(request.id, error)),
  );
});
