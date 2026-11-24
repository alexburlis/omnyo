import { useEffect, useMemo, useRef, useState } from "react";
import type { Root } from "mdast";
import type { Processor } from "unified";

import {
  markdownParseResponseSchema,
  type MarkdownParseRequest,
} from "./markdown-parse-protocol.js";

interface ParsedMarkdown extends MarkdownParseRequest {
  tree: Root;
}

interface ParseJob extends MarkdownParseRequest {
  owner: symbol;
  timer: ReturnType<typeof setTimeout>;
  resolve: (parsed: ParsedMarkdown) => void;
  reject: (error: Error) => void;
}

interface ParseOwner {
  cancel: () => void;
  dispose: () => void;
  request: (
    source: string,
    directives: boolean,
    resolve: ParseJob["resolve"],
    reject: ParseJob["reject"],
  ) => void;
}

const owners = new Set<symbol>();

const queued = new Map<symbol, ParseJob>();

let worker: Worker | null = null;

let active: ParseJob | null = null;

let nextId = 0;

function stopWorker(): void {
  worker?.terminate();
  worker = null;
}

function failActive(message: string): void {
  const job = active;
  active = null;
  stopWorker();

  if (job !== null) {
    clearTimeout(job.timer);
    job.reject(new Error(message));
    const pending = queued.get(job.owner);

    if (pending !== undefined) {
      clearTimeout(pending.timer);
      queued.delete(job.owner);
      pending.reject(new Error(message));
    }
  }

  drain();
}

function receiveMessage(event: MessageEvent<unknown>): void {
  const job = active;

  if (job === null) return;
  const parsed = markdownParseResponseSchema.safeParse(event.data);

  if (!parsed.success) {
    failActive("Markdown worker returned an invalid parse.");

    return;
  }

  const data = parsed.data;

  if (
    data.id !== job.id ||
    data.source !== job.source ||
    data.directives !== job.directives
  ) {
    return;
  }

  if ("error" in data) {
    failActive("Markdown parse failed.");

    return;
  }

  active = null;
  clearTimeout(job.timer);
  job.resolve({
    id: job.id,
    source: job.source,
    directives: job.directives,
    tree: data.tree,
  });
  drain();
}

function drain(): void {
  if (active !== null) return;
  const job = queued.values().next().value;

  if (job === undefined) return;
  queued.delete(job.owner);
  active = job;

  try {
    if (worker === null) {
      const created = new Worker(
        new URL("./markdown-parse.worker.ts", import.meta.url),
        { type: "module" },
      );

      worker = created;
      created.addEventListener("message", (event: MessageEvent<unknown>) => {
        if (worker === created) receiveMessage(event);
      });
      created.addEventListener("error", () => {
        if (worker === created) failActive("Markdown worker failed.");
      });
      created.addEventListener("messageerror", () => {
        if (worker === created) {
          failActive("Markdown worker returned an unreadable message.");
        }
      });
    }

    worker.postMessage({
      id: job.id,
      source: job.source,
      directives: job.directives,
    } satisfies MarkdownParseRequest);
  } catch {
    failActive("Markdown worker could not start.");
  }
}

function cancelOwner(owner: symbol): void {
  const pending = queued.get(owner);

  if (pending !== undefined) {
    clearTimeout(pending.timer);
    queued.delete(owner);
  }

  if (active?.owner === owner) {
    clearTimeout(active.timer);
    active = null;
    stopWorker();
  }

  drain();
}

function acquireOwner(): ParseOwner {
  const owner = Symbol();
  owners.add(owner);

  return {
    cancel: () => cancelOwner(owner),
    dispose() {
      owners.delete(owner);
      cancelOwner(owner);

      if (owners.size === 0) stopWorker();
    },
    request(source, directives, resolve, reject) {
      const previous = queued.get(owner);

      if (previous !== undefined) clearTimeout(previous.timer);

      const job: ParseJob = {
        id: ++nextId,
        source,
        directives,
        owner,
        resolve,
        reject,
        timer: setTimeout(() => {
          if (active === job) {
            failActive("Markdown parse timed out.");
          } else if (queued.get(owner) === job) {
            queued.delete(owner);
            reject(new Error("Markdown parse timed out."));
          }
        }, 2_000),
      };

      queued.set(owner, job);
      drain();
    },
  };
}

interface ParseGeneration {
  enabled: boolean;
}

interface ParseState {
  generation: ParseGeneration;
  config: object;
  source: string;
  directives: boolean;
  result: ParsedMarkdown | Error;
}

export function usePreparedMarkdownParse({
  config,
  directives,
  enabled,
  source,
}: {
  config: object;
  directives: boolean;
  enabled: boolean;
  source: string;
}): ParsedMarkdown | null {
  const owner = useRef<ParseOwner | null>(null);
  const generation = useMemo(() => ({ enabled }), [enabled]);
  const version = useRef(0);

  const previous = useRef<{
    config: object;
    directives: boolean;
    source: string;
  } | null>(null);

  const [state, setState] = useState<ParseState | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const acquired = acquireOwner();
    owner.current = acquired;

    return () => {
      version.current += 1;
      owner.current = null;
      previous.current = null;
      acquired.dispose();
    };
  }, [enabled]);

  useEffect(() => {
    const acquired = owner.current;

    if (!enabled || acquired === null) return;
    const currentVersion = ++version.current;
    const prior = previous.current;

    if (
      prior === null ||
      prior.config !== config ||
      prior.directives !== directives ||
      !source.startsWith(prior.source)
    ) {
      acquired.cancel();
    }

    previous.current = { config, directives, source };

    const update = (result: ParsedMarkdown | Error) => {
      if (version.current !== currentVersion || owner.current !== acquired)
        return;
      setState({ generation, config, directives, source, result });
    };

    acquired.request(source, directives, update, update);
  }, [config, directives, enabled, generation, source]);

  if (
    !enabled ||
    state === null ||
    state.generation !== generation ||
    state.config !== config ||
    state.directives !== directives ||
    state.source !== source
  ) {
    return null;
  }

  if (state.result instanceof Error) throw state.result;

  return state.result;
}

export function remarkPreparedMarkdown(
  this: Processor,
  {
    directives,
    prepared,
    source,
  }: { directives: boolean; prepared: ParsedMarkdown; source: string },
): void {
  if (prepared.source !== source || prepared.directives !== directives) {
    throw new Error("Markdown parse does not match the current message.");
  }

  this.parser = (value) => {
    if (value !== source) {
      throw new Error("Markdown parser received a different message.");
    }

    return structuredClone(prepared.tree);
  };
}
