import type { z } from "zod";
import type { workflowRpcContract } from "./src/workflow-contract";

export type Copy = z.output<
  (typeof workflowRpcContract)["workflow_install"]["output"]
>;

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function saveFile(text: string, filename: string) {
  const url = URL.createObjectURL(
    new Blob([text], {
      type: filename.endsWith(".md")
        ? "text/markdown;charset=utf-8"
        : "application/json",
    }),
  );

  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
