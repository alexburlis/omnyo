import { useLayoutEffect, useSyncExternalStore } from "react";
import { z } from "zod";
import type {
  ExperimentalProjectSidebarGroup,
  ExperimentalProjectSidebarItem,
  PluginSidebarProject,
} from "@omnyo/plugin-sdk";
import { PluginSlotMount } from "@/components/plugin/PluginSlotMount";
import {
  usePluginSlots,
  type ExperimentalProjectSidebarItemsSlot,
} from "./plugin-slots";
import { useSidebarThreads } from "./plugin-sidebar-hooks";

const callback = <T,>() => z.custom<T>((value) => typeof value === "function");

const itemSchema: z.ZodType<ExperimentalProjectSidebarItem> = z.lazy(() =>
  z.object({
    id: z.string().min(1),
    label: z.string().min(1),
    icon: z.string().min(1),
    href: z
      .string()
      .startsWith("/")
      .refine((value) => !value.startsWith("//")),
    threadId: z.string().min(1).optional(),
    status: z.object({ icon: z.string(), label: z.string() }).optional(),
    indicator: z
      .enum([
        "input-welcome",
        "callback-waiting",
        "dependency-failed",
        "unread-error",
        "waiting-for-input",
        "working-draft",
        "workflow",
        "background-agent",
        "background-command",
        "plan-mode",
        "goal",
        "runtime",
        "queued-failed",
        "queued-waiting",
        "draft",
        "unread-success",
        "ready-to-archive",
        "external",
        "open",
        "none",
      ])
      .optional(),
    count: z.number().int().nonnegative().optional(),
    unread: z.boolean().optional(),
    children: z.array(itemSchema).optional(),
    onRename:
      callback<
        NonNullable<ExperimentalProjectSidebarItem["onRename"]>
      >().optional(),
    onReorder:
      callback<
        NonNullable<ExperimentalProjectSidebarItem["onReorder"]>
      >().optional(),
    onDrop:
      callback<
        NonNullable<ExperimentalProjectSidebarItem["onDrop"]>
      >().optional(),
    menuItems: z
      .array(
        z.object({
          id: z.string().min(1),
          label: z.string().min(1),
          icon: z.string().optional(),
          destructive: z.boolean().optional(),
          run: callback<() => void | Promise<void>>(),
        }),
      )
      .optional(),
  }),
);

const groupsSchema = z
  .array(z.object({ projectId: z.string(), items: z.array(itemSchema) }))
  .superRefine((groups, context) => {
    const projects = new Set<string>();

    for (const group of groups) {
      if (projects.has(group.projectId))
        context.addIssue({
          code: "custom",
          message: "Duplicate project sidebar group",
        });
      projects.add(group.projectId);
      const ids = new Set<string>();

      function visit(items: readonly ExperimentalProjectSidebarItem[]) {
        for (const item of items) {
          if (ids.has(item.id))
            context.addIssue({
              code: "custom",
              message: "Duplicate project sidebar item",
            });
          ids.add(item.id);

          if (item.children) visit(item.children);
        }
      }

      visit(group.items);
    }
  });

const collected = new Map<string, readonly ExperimentalProjectSidebarGroup[]>();

const listeners = new Set<() => void>();

let snapshot: readonly ExperimentalProjectSidebarGroup[] = [];

function publish() {
  snapshot = [...collected.values()].flat();

  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

export function useProjectSidebarItems() {
  return useSyncExternalStore(subscribe, () => snapshot);
}

function Collector({
  slot,
  projects,
}: {
  slot: ExperimentalProjectSidebarItemsSlot;
  projects: readonly PluginSidebarProject[];
}) {
  const groups = groupsSchema.parse(slot.useItems({ projects }));
  const key = `${slot.pluginId}/${slot.id}`;
  useLayoutEffect(() => {
    const allowedProjects = new Set(projects.map((project) => project.id));
    collected.set(
      key,
      groups
        .filter((group) => allowedProjects.has(group.projectId))
        .map((group) => ({ ...group, key: `${key}/${group.projectId}` })),
    );
    publish();

    return () => {
      collected.delete(key);
      publish();
    };
  }, [groups, key, projects]);

  return null;
}

export function ProjectSidebarItemsCollectors() {
  const { projects } = useSidebarThreads();
  const { projectSidebarItems } = usePluginSlots();

  return projectSidebarItems.map((slot) => (
    <PluginSlotMount
      key={`${slot.pluginId}/${slot.id}/${slot.generation}`}
      pluginId={slot.pluginId}
      slotKind="projectSidebarItems"
      slotId={slot.id}
      pendingFallback={null}
    >
      <Collector slot={slot} projects={projects} />
    </PluginSlotMount>
  ));
}
