import type { ComponentProps } from "react";
import type { z } from "zod";
import { statusSchema } from "../contract";
import { modelLabel } from "../src/ui/models";
import type { SentryView } from "../src/ui/view";

const accept = async () => true;

const ignore = () => {};

let nextResourceId = 0;

type ViewProps = ComponentProps<typeof SentryView>;

export function inboxViewProps(
  status: z.input<typeof statusSchema> | null,
  {
    snapshot,
    client,
    ...props
  }: Partial<Pick<ViewProps, "onOpenThread" | "ModelPicker">> & {
    snapshot?: Partial<ViewProps["snapshot"]>;
    client?: Partial<ViewProps["client"]>;
  } = {},
): ViewProps {
  return {
    snapshot: {
      badge: status?.badge ?? null,
      badgeRefreshing: false,
      badgeError: null,
      status: status && statusSchema.parse(status),
      targets: { projects: [], hosts: [] },
      targetsLoaded: false,
      refreshing: false,
      pending: [],
      error: null,
      targetsError: null,
      ...snapshot,
    },
    client: {
      resourceId: --nextResourceId,
      addProject: accept,
      catalog: async () => [],
      investigate: accept,
      listInbox: async () => ({ incidents: [], total: 0 }),
      loadTargets: ignore,
      repositories: async () => [],
      resumeBatch: accept,
      retry: accept,
      saveModel: accept,
      savePolicy: accept,
      saveRoute: accept,
      solveAll: accept,
      stop: accept,
      stopBatch: accept,
      sync: accept,
      toggleRoute: accept,
      ...client,
    },
    onOpenThread: ignore,
    ModelPicker: ({ value }) => (
      <span style={{ color: "var(--sentry-muted)", overflowWrap: "anywhere" }}>
        {modelLabel(value)}
      </span>
    ),
    ...props,
  };
}
