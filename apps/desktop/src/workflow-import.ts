import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import {
  workflowImportReferenceSchema,
  type WorkflowImportReference,
} from "@omnyo/desktop-contract";

export function parseWorkflowImportLink(
  value: string,
): WorkflowImportReference | null {
  if (value.length > 256) return null;

  const match = /^omnyo:\/\/workflows\/import\/([a-f0-9]{32})$/.exec(value);

  if (!match?.[1]) return null;

  return { kind: "share", shareId: match[1] };
}

export async function readWorkflowImportFile(
  path: string,
): Promise<WorkflowImportReference> {
  if (!isAbsolute(path) || !/\.omnyoworkflow$/i.test(path))
    throw new Error("Expected a workflow file.");
  const source = await lstat(path);

  if (!source.isFile() || source.isSymbolicLink())
    throw new Error("Expected a regular workflow file.");

  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );

  try {
    const stat = await handle.stat();

    if (
      !stat.isFile() ||
      stat.ino !== source.ino ||
      stat.dev !== source.dev ||
      stat.size > 256 * 1024
    )
      throw new Error("Workflow file exceeds the supported size.");

    if (stat.mode & 0o111)
      throw new Error("Workflow files must be plain data.");
    const bytes = Buffer.alloc(256 * 1024 + 1);
    let length = 0;

    while (length < bytes.length) {
      const result = await handle.read(
        bytes,
        length,
        bytes.length - length,
        null,
      );

      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }

    if (length > 256 * 1024)
      throw new Error("Workflow file exceeds the supported size.");

    return workflowImportReferenceSchema.parse({
      kind: "file",
      filename: basename(path),
      text: new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(0, length),
      ),
    });
  } finally {
    await handle.close();
  }
}

export class WorkflowImportQueue {
  private readonly entries: WorkflowImportReference[] = [];
  add(entry: WorkflowImportReference): void {
    if (this.entries.length >= 8)
      throw new Error(
        "Review the pending workflow imports before opening more.",
      );
    this.entries.push(workflowImportReferenceSchema.parse(entry));
  }
  take(): WorkflowImportReference | null {
    return this.entries.shift() ?? null;
  }
  get pending(): boolean {
    return this.entries.length > 0;
  }
}

export function workflowImportDestination(serverUrl: string): string {
  const url = new URL(serverUrl);

  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("Expected a connected coordinator.");
  url.pathname = `${url.pathname.replace(/\/$/, "")}/plugins/automations/automations/import`;
  url.search = "";
  url.hash = "";

  return url.href;
}
