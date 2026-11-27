import {
  experimental_copyToClipboard,
  experimental_useAppNavigate,
  experimental_usePluginId,
  experimental_useSidebarThreads,
  useRpc,
  type ExperimentalProjectSidebarItem,
  type ExperimentalProjectSidebarItemsRegistration,
} from "@omnyo/plugin-sdk/app";
import type { CanvasRpcContract } from "../contract";
import { type ProjectCanvas, type ProjectSection, type ProjectView } from "../project-contract";
import { activeRegion, projectHomeViewId, projectOverviewId, sectionOwnView } from "./project-home";
import { projectPath, projectHref } from "./project-route";
import { useProjectSidebarData } from "./project-data";

import { useProjectHistory } from "./project-history";

function ordered<T extends { order: number; id: string }>(items: readonly T[]): T[] {
  return [...items].sort(
    (left, right) => left.order - right.order || left.id.localeCompare(right.id),
  );
}

function viewInput(view: ProjectView) {
  return {
    id: view.id,
    title: view.title,
    anchorKind: view.anchorKind,
    regionId: view.regionId,
    anchorId: view.anchorId,
    rect: view.rect,
  };
}

function useItems({
  projects,
}: Parameters<ExperimentalProjectSidebarItemsRegistration["useItems"]>[0]) {
  const rpc = useRpc<CanvasRpcContract>();
  const remember = useProjectHistory();
  const pluginId = experimental_usePluginId();
  const navigate = experimental_useAppNavigate();

  const { threads } = experimental_useSidebarThreads({
    experimental_lifecycles: ["active", "shelved"],
  });

  const { entry, refresh } = useProjectSidebarData(projects);

  return projects.map(({ id: projectId }) => {
    const data = entry.value?.find((row) => row.projectId === projectId);
    const project = data?.project;

    const href = (target?: Parameters<typeof projectHref>[2]) =>
      projectHref(pluginId, projectId, target);

    const copy = (id: string, link: string) => ({
      id: `copy-${id}`,
      label: "Copy link",
      icon: "Link" as const,
      run: async () => {
        if (
          !(await experimental_copyToClipboard({ text: new URL(link, window.location.href).href }))
        )
          throw new Error("The link could not be copied.");
      },
    });

    const mutation = (value: ProjectCanvas) => ({
      projectId,
      actor: "human" as const,
      expectedRevision: value.revision,
    });

    const update = async (
      action: (value: ProjectCanvas) => Promise<ProjectCanvas | readonly ProjectCanvas[]>,
    ) => {
      try {
        const current = await rpc.call("project.get", { projectId });
        const result = await action(current);

        if (!("projectId" in result) || result.revision !== current.revision)
          await remember(result);
      } finally {
        refresh();
      }
    };

    const viewItem = (view: ProjectView): ExperimentalProjectSidebarItem => ({
      id: `view:${view.id}`,
      label: view.title,
      icon: "Locate",
      href: href({ kind: "v", id: view.id }),
      onRename: (title) =>
        update((value) => {
          const current = value.views.find((item) => item.id === view.id);

          if (!current) throw new Error("This view no longer exists.");

          return rpc.call("project.view.put", { ...mutation(value), ...viewInput(current), title });
        }),
      menuItems: [
        {
          id: "update",
          label: "Update view to current position",
          icon: "Locate",
          run: () => {
            navigate.toPluginPanel("p", {
              subPath: projectPath(projectId, { kind: "u", id: view.id }),
            });
          },
        },
        {
          id: "home",
          label: "Set as home",
          icon: "Star",
          run: () =>
            update((value) => rpc.call("project.view.home", { ...mutation(value), id: view.id })),
        },
        copy(view.id, href({ kind: "v", id: view.id })),
        {
          id: "remove",
          label: "Remove",
          icon: "Trash",
          destructive: true,
          run: () =>
            update((value) => rpc.call("project.view.remove", { ...mutation(value), id: view.id })),
        },
      ],
    });

    const openChatsOf = (value: ProjectCanvas) =>
      value.chats.flatMap((chat) => {
        const thread = threads.find(
          (item) => item.id === chat.threadId && item.projectId === projectId,
        );

        return chat.role === "spawned" &&
          chat.state === "open" &&
          thread &&
          !thread.isArchived &&
          !thread.isHidden
          ? [{ chat, thread }]
          : [];
      });

    const openChats = project ? openChatsOf(project) : [];
    const overviewId = projectOverviewId(projectId);

    const hasContent = (value: ProjectCanvas) =>
      value.sections.some((section) => section.archivedAt === null) ||
      openChatsOf(value).length > 0 ||
      value.views.some((view) => view.id !== overviewId && activeRegion(value, view.regionId));

    const listedViews = (value: ProjectCanvas, regionId: string | null) => {
      const home = projectHomeViewId(value);
      const content = hasContent(value);

      return ordered(
        value.views.filter(
          (view) =>
            view.regionId === regionId &&
            view.id !== home &&
            (content || view.id !== overviewId) &&
            !(
              sectionOwnView(view) &&
              value.sections.some(
                (section) => section.id === view.regionId && section.title === view.title,
              )
            ),
        ),
      );
    };

    const nested = (items: ExperimentalProjectSidebarItem[]) =>
      items.length === 1 && items[0]?.id.startsWith("view:") ? [] : items;

    const chatItem = ({
      chat,
      thread,
    }: (typeof openChats)[number]): ExperimentalProjectSidebarItem => ({
      id: `chat:${chat.threadId}`,
      threadId: chat.threadId,
      label: thread.displayTitle,
      icon: "MessageCircle",
      href: href({ kind: "c", id: chat.threadId }),
      indicator: thread.indicator,
      unread: thread.isUnread,
      menuItems: [copy(chat.threadId, href({ kind: "c", id: chat.threadId }))],
    });

    const reorder = (regionId: string | null, childIds: readonly string[]) =>
      update(async (value) => {
        const changes: ProjectCanvas[] = [];
        const views = listedViews(value, regionId);

        const viewIds = childIds.flatMap((id) =>
          views.filter((view) => `view:${view.id}` === id).map((view) => view.id),
        );

        if (viewIds.length !== views.length || new Set(viewIds).size !== views.length)
          throw new Error("The Canvas contents changed. Retry the move.");
        const sections = ordered(value.sections.filter((section) => section.archivedAt === null));

        const sectionIds = childIds.flatMap((id) =>
          sections.filter((section) => `section:${section.id}` === id).map((section) => section.id),
        );

        if (
          regionId === null &&
          (sectionIds.length !== sections.length || new Set(sectionIds).size !== sections.length)
        )
          throw new Error("The Canvas contents changed. Retry the move.");

        try {
          if (viewIds.some((id, index) => id !== views[index]?.id)) {
            const global = ordered(value.views).map((view) => view.id);
            let index = 0;
            const members = new Set(viewIds);
            const ids = global.map((id) => (members.has(id) ? (viewIds[index++] ?? id) : id));
            const before = value.revision;
            value = await rpc.call("project.view.reorder", { ...mutation(value), ids });

            if (value.revision !== before) changes.push(value);
          }

          if (regionId === null && sectionIds.some((id, index) => id !== sections[index]?.id)) {
            for (const [order, sectionId] of sectionIds.entries()) {
              const before = value.revision;
              value = await rpc.call("project.section.update", {
                ...mutation(value),
                sectionId,
                order,
              });

              if (value.revision !== before) changes.push(value);
            }
          }
        } catch (error) {
          if (changes.length > 0) {
            try {
              await remember(changes);
            } catch (historyError) {
              const message = error instanceof Error ? error.message : "The move failed.";

              throw new AggregateError(
                [error, historyError],
                `${message} Change saved, but Undo could not be prepared.`,
                { cause: error },
              );
            }
          }

          throw error;
        }

        return changes;
      });

    const activeSections = ordered(
      project?.sections.filter((section) => section.archivedAt === null) ?? [],
    );

    const sectionChildren = (section: ProjectSection) =>
      nested([
        ...(project ? listedViews(project, section.id) : []).map(viewItem),
        ...openChats.filter(({ chat }) => chat.regionId === section.id).map(chatItem),
      ]);

    const sections = activeSections.map((section): ExperimentalProjectSidebarItem => {
      const chats = openChats.filter(({ chat }) => chat.regionId === section.id);
      const children = sectionChildren(section);

      const row: ExperimentalProjectSidebarItem = {
        id: `section:${section.id}`,
        label: section.title,
        icon: "LayoutDashboard",
        href: href({ kind: "s", id: section.id }),
        unread: data?.unseen.includes(section.id),
        count: chats.filter(
          ({ thread }) => thread.hasPendingInteraction || thread.indicator === "waiting-for-input",
        ).length,
        onRename: (title) =>
          update((value) =>
            rpc.call("project.section.update", {
              ...mutation(value),
              sectionId: section.id,
              title,
            }),
          ),
        onDrop: (id) =>
          update((value) => {
            const chat = value.chats.find(
              (item) =>
                `chat:${item.threadId}` === id && item.role === "spawned" && item.state === "open",
            );

            const target = value.sections.find(
              (item) => item.id === section.id && item.archivedAt === null,
            );

            if (!chat || !target) throw new Error("The chat or section is no longer available.");

            return rpc.call("project.chat.move", {
              ...mutation(value),
              threadId: chat.threadId,
              regionId: target.id,
              anchorKind: "section",
              anchorId: target.id,
              x: 0,
              y: 0,
            });
          }),
        menuItems: [
          copy(section.id, href({ kind: "s", id: section.id })),
          {
            id: "archive",
            label: "Archive",
            icon: "Archive",
            run: () =>
              update((value) =>
                rpc.call("project.section.archive", { ...mutation(value), sectionId: section.id }),
              ),
          },
        ],
      };

      if (children.length > 0) {
        row.children = children;
        row.onReorder = (ids) => reorder(section.id, ids);
      }

      return row;
    });

    const rootViews = project ? listedViews(project, null) : [];

    const freeChats = openChats.filter(
      ({ chat }) =>
        chat.regionId === null || !activeSections.some((section) => section.id === chat.regionId),
    );

    const folded =
      activeSections.length === 1 && rootViews.length === 0 && freeChats.length === 0
        ? activeSections[0]
        : undefined;

    const children = folded
      ? nested((project ? listedViews(project, folded.id) : []).map(viewItem))
      : nested([...rootViews.map(viewItem), ...sections, ...freeChats.map(chatItem)]);

    const error = data?.error ?? entry.error;

    const item: ExperimentalProjectSidebarItem = {
      id: `canvas:${projectId}`,
      label: "Canvas",
      icon: "GridView",
      href: project && hasContent(project) ? href({ kind: "h" }) : href(),
      unread: (data?.unseen.length ?? 0) > 0,
    };

    if (folded && sections[0]?.count) item.count = sections[0].count;

    if (children.length > 0) {
      item.children = children;
      item.onReorder = (ids) => reorder(folded?.id ?? null, ids);
    }

    if (error) {
      item.status = { icon: "CircleAlert", label: error };
      item.menuItems = [{ id: "retry", label: "Retry Canvas", run: refresh }];
    }

    return { projectId, items: [item] };
  });
}

export const projectSidebarItems: ExperimentalProjectSidebarItemsRegistration = {
  id: "project-canvas",
  useItems,
};
