import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SHARE_ENV, Worker } from "node:worker_threads";
import { shouldCreateProcessGroup } from "@omnyo/process-utils";
import {
  fileSearchResponseSchema,
  type FileSearchQuery,
  type FileSearchRequest,
} from "./file-search-protocol.js";

interface PendingSearch {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

const WORKER_ENTRY_CANDIDATES = [
  "./omnyo-file-search-worker.mjs",
  "./file-search-worker.js",
  "./file-search-worker.ts",
];

const pendingSearches = new Map<number, PendingSearch>();

let worker: Worker | null = null;

let nextRequestId = 0;

export function searchInFileSearchWorker(
  query: FileSearchQuery,
): Promise<unknown> {
  const owner = worker ?? startWorker();
  const request: FileSearchRequest = { ...query, id: nextRequestId++ };

  return new Promise((resolve, reject) => {
    pendingSearches.set(request.id, { resolve, reject });
    owner.ref();
    owner.postMessage(request);
  });
}

function startWorker(): Worker {
  const created = createWorker(workerEntryPath());
  worker = created;

  created.on("message", (message: unknown) => {
    const parsed = fileSearchResponseSchema.safeParse(message);

    if (!parsed.success) {
      retire(created, new Error("it sent an invalid response"));
      void created.terminate();

      return;
    }

    const response = parsed.data;
    const pending = pendingSearches.get(response.id);

    if (pending === undefined) return;

    pendingSearches.delete(response.id);

    if (pendingSearches.size === 0) created.unref();

    if (response.ok) {
      pending.resolve(response.result);

      return;
    }

    pending.reject(
      Object.assign(
        new Error(response.error.message),
        response.error.code !== undefined ? { code: response.error.code } : {},
      ),
    );
  });

  created.on("error", (error) => retire(created, error));
  created.on("exit", (exitCode) =>
    retire(created, new Error(`it exited with code ${exitCode}`)),
  );

  return created;
}

function retire(owner: Worker, cause: Error): void {
  if (worker !== owner) return;

  worker = null;

  const error = new Error(`File search worker stopped: ${cause.message}`, {
    cause,
  });

  for (const pending of pendingSearches.values()) pending.reject(error);

  pendingSearches.clear();
}

function createWorker(entryPath: string): Worker {
  if (!entryPath.endsWith(".ts")) {
    return new Worker(entryPath, {
      execArgv: [],
      env: SHARE_ENV,
      workerData: { inheritProcessGroup: !shouldCreateProcessGroup() },
    });
  }

  const api = import.meta.resolve("tsx/esm/api");
  const entry = pathToFileURL(entryPath).href;
  const bootstrap = `(async()=>{const{register}=await import(${JSON.stringify(api)});register();await import(${JSON.stringify(entry)});})();`;

  return new Worker(bootstrap, {
    eval: true,
    execArgv: ["--conditions=source"],
    env: SHARE_ENV,
    workerData: { inheritProcessGroup: !shouldCreateProcessGroup() },
  });
}

function workerEntryPath(): string {
  for (const candidate of WORKER_ENTRY_CANDIDATES) {
    const candidatePath = fileURLToPath(new URL(candidate, import.meta.url));

    if (existsSync(candidatePath)) return candidatePath;
  }

  throw new Error(
    `file search worker entry not found beside ${fileURLToPath(import.meta.url)} (looked for ${WORKER_ENTRY_CANDIDATES.join(", ")})`,
  );
}
