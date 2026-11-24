import { createServerFn } from "@tanstack/react-start";

import { workflowCatalog } from "./entries.server";

export const listPublishedWorkflows = createServerFn({ method: "GET" }).handler(
  () => workflowCatalog.listings,
);

export const getPublishedWorkflow = createServerFn({ method: "GET" })
  .validator((input: string) => (typeof input === "string" ? input : ""))
  .handler(({ data }) => workflowCatalog.detail(data));
