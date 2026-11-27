import { CanvasError } from "./lib/errors.ts";
import {
  cliCommand,
  PluginCliError,
  type PluginApi,
  type PluginCliContext,
  type PluginAgentToolContext,
  type PluginRpcHandlers,
} from "@omnyo/plugin-sdk";
import { z } from "zod";
import { boardReferenceSchema, type BoardAddress } from "./board-contract";
import {
  coordinateSchema,
  viewAnchorKindSchema,
  projectRpc,
  projectSectionCreateSchema,
  projectSectionUpdateSchema,
  projectSectionActionSchema,
  projectViewPutSchema,
  projectViewRemoveSchema,
  type ProjectMutation,
} from "./project-contract";
import { type CanvasService } from "./lib/service";
import { ProjectService } from "./lib/project";
import type { SourceService } from "./lib/sources";

const json = { json: { type: "boolean", description: "Print structured JSON" } } as const;

const projectOptions = {
  ...json,
  project: {
    type: "string",
    description: "Omnyo project ID; defaults to the invoking chat's project",
  },
} as const;

const sectionOption = { type: "string", description: "Project canvas section ID" } as const;

const mutationOptions = {
  ...projectOptions,
  input: { type: "string", required: true, stdin: true, description: "Operation JSON" },
} as const;

export function projectIntegration(api: PluginApi, service: CanvasService, sources: SourceService) {
  const projects = new ProjectService(api, service, sources);

  function rpcBoard(input: BoardAddress): string {
    return projects.resolveBoard(
      boardReferenceSchema.parse(input.board ?? { threadId: input.threadId }),
    );
  }

  function agentBoard(
    context: PluginAgentToolContext,
    board?: z.infer<typeof boardReferenceSchema>,
    write = false,
  ): string {
    if (write && board === undefined && projects.link(context.threadId)?.regionId === null)
      throw new CanvasError("Create a project section first, then add modules to that section");
    const key = projects.resolveBoard(board ?? { threadId: context.threadId });
    const projectId = projects.boardProject(key);

    if (projectId !== null) {
      if (projectId !== context.projectId)
        throw new CanvasError("That section belongs to another project");

      if (write && projects.link(context.threadId)?.projectId !== projectId)
        throw new CanvasError(
          "Join the project canvas first with omnyo canvas project join, so you receive its brief",
        );

      if (write) projects.assertWritable(key, "agent");
    }

    return key;
  }

  function brief(threadId: string): string | null {
    const link = projects.link(threadId);

    if (link === null) return null;
    const canvas = projects.get(link.projectId);
    const anchor = link.regionId === null ? null : projects.getSection(link.regionId);

    const x = link.x + (anchor?.x ?? 0),
      y = link.y + (anchor?.y ?? 0);

    const sections = canvas.sections
      .filter((section) => section.archivedAt === null)
      .sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y));

    const target =
      link.regionId === null
        ? "Whole canvas. Create a section before adding modules."
        : `Section ${link.regionId}${link.anchorId ? `, ${link.anchorKind} ${link.anchorId}` : ""}.`;

    const prefix = `Project canvas ${link.projectId}. Target: ${target}\nSections:\n`;

    const rules =
      "Work in the target section. Create a new section for a different topic and save a view after creating a section or significant island. Never move or archive owner-placed sections, views or chat cards unless asked. Locked sections reject agent writes. Inspect before editing and preserve human edits with field versions. Existing Canvas commands resolve this chat's linked section; use board: {sectionId} to select another section in this project. Reply briefly and link every changed module as [title](#canvas-node-ID). Read the Canvas skill for module schemas, layout, sources and history.";

    let contents = "";
    let count = 0;

    for (const section of sections) {
      const line = `${JSON.stringify(section.title)}: ${section.id}${section.locked ? " (locked)" : ""}\n`;

      if (prefix.length + contents.length + line.length + rules.length + 80 > 4096) break;
      contents += line;
      count++;
    }

    if (count < sections.length)
      contents += `${sections.length - count} more sections; read canvas_project for the full contents.\n`;

    return `${prefix}${contents}${rules}`;
  }

  async function checkThread(projectId: string, threadId: string) {
    const thread = await api.sdk.threads.get({ threadId });

    if (thread.projectId !== projectId)
      throw new CanvasError("That chat belongs to another project");

    return thread;
  }

  async function replay(input: ProjectMutation & { changeId?: string }, action: "undo" | "redo") {
    if ((input.actor ?? "agent") === "agent" && input.expectedRevision === undefined)
      throw new CanvasError("Inspect the project revision before undo or redo");
    const expectedRevision = input.expectedRevision ?? projects.get(input.projectId).revision;
    await Promise.all(
      projects
        .historyOrigins(input.projectId, action, input.changeId)
        .map((id) => checkThread(input.projectId, id)),
    );

    return projects[action]({ ...input, expectedRevision });
  }

  const human = <T extends ProjectMutation>(input: T) => ({
    ...input,
    actor: "human" as const,
    actingThreadId: undefined,
  });

  const rpc: PluginRpcHandlers<typeof projectRpc> = {
    "project.get": (input) => projects.get(input.projectId),
    "project.section.create": (input) => {
      projects.createSection(human(input));

      return projects.get(input.projectId);
    },
    "project.section.update": (input) => {
      projects.updateSection(human(input));

      return projects.get(input.projectId);
    },
    "project.section.move": (input) => {
      projects.updateSection(human(input));

      return projects.get(input.projectId);
    },
    "project.section.archive": (input) => {
      projects.archiveSection(human(input));

      return projects.get(input.projectId);
    },
    "project.section.restore": (input) => {
      projects.restoreSection(human(input));

      return projects.get(input.projectId);
    },
    "project.view.put": (input) => {
      projects.putView(human(input));

      return projects.get(input.projectId);
    },
    "project.view.remove": (input) => {
      projects.removeView(human(input));

      return projects.get(input.projectId);
    },
    "project.view.reorder": (input) => {
      projects.reorderViews(human(input));

      return projects.get(input.projectId);
    },
    "project.view.home": (input) => {
      projects.setHome(human(input));

      return projects.get(input.projectId);
    },
    "project.chat.put": async (input) => {
      await checkThread(input.projectId, input.threadId);
      projects.putChat(human(input));

      return projects.get(input.projectId);
    },
    "project.chat.move": (input) => {
      projects.moveChat(human(input));

      return projects.get(input.projectId);
    },
    "project.chat.resolve": (input) => {
      projects.resolveChat(human(input));

      return projects.get(input.projectId);
    },
    "project.adopt": async (input) => {
      await checkThread(input.projectId, input.threadId);
      projects.adopt(human(input));

      return projects.get(input.projectId);
    },
    "project.return": async (input) => {
      const origin = projects.getSection(input.sectionId)?.originThreadId;

      if (!origin) throw new CanvasError("The original chat no longer exists");
      await checkThread(input.projectId, origin);
      projects.return(human(input));

      return projects.get(input.projectId);
    },
    "project.join": async (input) => {
      await checkThread(input.projectId, input.threadId);
      projects.join(human(input));
      service.enable(input.threadId, "user");

      return projects.get(input.projectId);
    },
    "project.journal": (input) => projects.journal(input.projectId, input.revisions),
    "project.undo": (input) => replay(human(input), "undo"),
    "project.redo": (input) => replay(human(input), "redo"),
  };

  async function projectId(
    explicit: string | undefined,
    context: PluginCliContext,
  ): Promise<string> {
    if (context.threadId) {
      const thread = await api.sdk.threads.get({ threadId: context.threadId });

      if (explicit !== undefined) {
        await api.sdk.projects.get({ projectId: explicit });

        return explicit;
      }

      return thread.projectId;
    }

    const value = explicit ?? context.projectId;

    if (!value) throw new CanvasError("Supply --project outside a project chat");
    await api.sdk.projects.get({ projectId: value });

    return value;
  }

  type ProjectCliValue = z.infer<ReturnType<typeof z.json>> | void;

  async function result(run: () => ProjectCliValue | Promise<ProjectCliValue>) {
    try {
      return { exitCode: 0, stdout: JSON.stringify(await run()) };
    } catch (error) {
      if (error instanceof CanvasError) throw new PluginCliError(error.message, { code: "canvas" });
      throw error;
    }
  }

  function requireJoined(context: PluginCliContext, id: string) {
    if (context.threadId && projects.link(context.threadId)?.projectId !== id)
      throw new CanvasError("Join the project canvas first with omnyo canvas project join");
  }

  const pendingChats = new Map<string, Promise<void>>();

  const canvasChatMetadata = z.object({
    canvasChat: z.literal(true),
    projectId: z.string().min(1),
    regionId: z.string().nullable().optional(),
    anchorKind: viewAnchorKindSchema,
    anchorId: z.string().nullable().optional(),
    x: coordinateSchema,
    y: coordinateSchema,
  });

  function ensureCanvasChat(
    thread: Awaited<ReturnType<PluginApi["sdk"]["threads"]["get"]>>,
  ): Promise<void> {
    if (projects.link(thread.id) !== null || thread.originPluginId !== api.pluginId)
      return Promise.resolve();
    const pending = pendingChats.get(thread.id);

    if (pending) return pending;

    const task = (async () => {
      const raw = await api.sdk.threads.getPluginMetadata({ threadId: thread.id });
      const marker = z.object({ canvasChat: z.unknown().optional() }).parse(raw);

      if (marker.canvasChat !== true) return;
      const metadata = canvasChatMetadata.parse(raw);

      if (metadata.projectId !== thread.projectId)
        throw new CanvasError("Canvas chat target belongs to another project");

      if (thread.visibility !== "visible" || thread.archivedAt !== null)
        throw new CanvasError("Canvas chats must be visible and unarchived");
      projects.putChat({
        ...metadata,
        threadId: thread.id,
        actor: "system",
        role: "spawned",
        state: "open",
      });
      service.enable(thread.id, "user");
    })();

    pendingChats.set(thread.id, task);
    void task.then(
      () => pendingChats.delete(thread.id),
      () => pendingChats.delete(thread.id),
    );

    return task;
  }

  function createSectionForChat(
    input: z.infer<typeof projectSectionCreateSchema>,
    threadId?: string,
  ) {
    const section = projects.createSection(input);
    const link = threadId ? projects.link(threadId) : null;

    if (link?.regionId === null)
      projects.moveChat({
        projectId: section.projectId,
        threadId: link.threadId,
        regionId: section.id,
        anchorKind: "section",
        anchorId: section.id,
        x: 0,
        y: 0,
        actor: "system",
      });

    return section;
  }

  const commands = {
    "project chat": cliCommand({
      summary: "Start a visible canvas chat at a section or free-space anchor",
      options: {
        ...projectOptions,
        at: { type: "string", required: true, description: "Section ID or free" },
        prompt: { type: "string", required: true, stdin: true, description: "First message" },
        x: {
          type: "integer",
          min: -1000000,
          max: 1000000,
          default: 0,
          description: "Anchor x; section-relative or absolute in free space",
        },
        y: {
          type: "integer",
          min: -1000000,
          max: 1000000,
          default: 0,
          description: "Anchor y; section-relative or absolute in free space",
        },
      },
      run: (input, context) =>
        result(async () => {
          const id = await projectId(input.options.project, context);

          const section =
            input.options.at === "free" ? null : projects.getSection(input.options.at);

          if (
            input.options.at !== "free" &&
            (section === null || section.projectId !== id || section.archivedAt !== null)
          )
            throw new CanvasError("Choose an active section in this project");

          const thread = await api.sdk.threads.spawn({
            projectId: id,
            environment: { type: "project-default" },
            prompt: input.options.prompt,
            visibility: "visible",
            pluginMetadata: {
              canvasChat: true,
              projectId: id,
              regionId: section?.id ?? null,
              anchorKind: section ? "section" : "free",
              anchorId: section?.id ?? null,
              x: input.options.x,
              y: input.options.y,
            },
          });

          await ensureCanvasChat(thread);

          return { threadId: thread.id, anchor: projects.link(thread.id) };
        }),
    }),
    "project show": cliCommand({
      summary: "Read a project's canvas, sections, views and chat anchors",
      options: projectOptions,
      run: (input, context) =>
        result(async () => projects.get(await projectId(input.options.project, context))),
    }),
    "project sections": cliCommand({
      summary: "List project canvas sections",
      options: projectOptions,
      run: (input, context) =>
        result(async () => projects.get(await projectId(input.options.project, context)).sections),
    }),
    "project views": cliCommand({
      summary: "List saved project canvas views",
      options: projectOptions,
      run: (input, context) =>
        result(async () => projects.get(await projectId(input.options.project, context)).views),
    }),
    "project chats": cliCommand({
      summary: "List project canvas chats",
      options: projectOptions,
      run: (input, context) =>
        result(async () => projects.get(await projectId(input.options.project, context)).chats),
    }),
    "project add": cliCommand({
      summary: "Move a chat board into its project canvas with a live link",
      options: {
        ...projectOptions,
        title: { type: "string", description: "Section title; defaults to the chat title" },
      },
      positionals: [
        { name: "chat", required: true, description: "Chat whose board becomes a section" },
      ],
      run: (input, context) =>
        result(async () => {
          const thread = await api.sdk.threads.get({ threadId: input.positionals.chat });
          const id = input.options.project ?? thread.projectId;
          await checkThread(id, thread.id);

          return projects.adopt({
            projectId: id,
            threadId: thread.id,
            title: input.options.title ?? thread.title ?? thread.titleFallback ?? "Chat board",
            actor: context.threadId ? "agent" : "human",
            actingThreadId: context.threadId,
          });
        }),
    }),
    "project return": cliCommand({
      summary: "Move an adopted section back to its surviving origin chat",
      options: {
        ...projectOptions,
        "expected-revision": {
          type: "integer",
          min: 0,
          max: Number.MAX_SAFE_INTEGER,
          description: "Inspected project revision required for agent returns",
        },
      },
      positionals: [{ name: "section", required: true, description: "Adopted section ID" }],
      run: (input, context) =>
        result(async () => {
          const section = projects.getSection(input.positionals.section);

          if (!section?.originThreadId) throw new CanvasError("The original chat no longer exists");

          if (input.options.project && input.options.project !== section.projectId)
            throw new CanvasError("That section belongs to another project");
          await checkThread(section.projectId, section.originThreadId);

          return projects.return({
            projectId: section.projectId,
            sectionId: section.id,
            actor: context.threadId ? "agent" : "human",
            actingThreadId: context.threadId,
            expectedRevision: input.options["expected-revision"],
          });
        }),
    }),
    "project journal": cliCommand({
      summary: "List structural Canvas changes and their undo or redo state",
      options: projectOptions,
      run: (input, context) =>
        result(async () => projects.journal(await projectId(input.options.project, context))),
    }),
    "project undo": cliCommand({
      summary: "Undo a structural Canvas change with ownership and revision checks",
      options: {
        ...projectOptions,
        "change-id": {
          type: "string",
          description: "Journal change ID; defaults to the latest eligible change",
        },
        "expected-revision": {
          type: "integer",
          min: 0,
          max: Number.MAX_SAFE_INTEGER,
          description: "Inspected project revision",
        },
      },
      run: (input, context) =>
        result(async () => {
          const id = await projectId(input.options.project, context);
          requireJoined(context, id);

          return replay(
            {
              projectId: id,
              changeId: input.options["change-id"],
              expectedRevision: input.options["expected-revision"],
              actor: context.threadId ? "agent" : "human",
              actingThreadId: context.threadId,
            },
            "undo",
          );
        }),
    }),
    "project redo": cliCommand({
      summary: "Redo a structural Canvas change with ownership and revision checks",
      options: {
        ...projectOptions,
        "change-id": {
          type: "string",
          description: "Journal change ID; defaults to the latest eligible change",
        },
        "expected-revision": {
          type: "integer",
          min: 0,
          max: Number.MAX_SAFE_INTEGER,
          description: "Inspected project revision",
        },
      },
      run: (input, context) =>
        result(async () => {
          const id = await projectId(input.options.project, context);
          requireJoined(context, id);

          return replay(
            {
              projectId: id,
              changeId: input.options["change-id"],
              expectedRevision: input.options["expected-revision"],
              actor: context.threadId ? "agent" : "human",
              actingThreadId: context.threadId,
            },
            "redo",
          );
        }),
    }),
    "project join": cliCommand({
      summary: "Link the invoking chat to the project canvas and receive its brief",
      options: { ...projectOptions, section: sectionOption },
      run: (input, context) =>
        result(async () => {
          const id = await projectId(input.options.project, context);

          if (!context.threadId) throw new CanvasError("Run join inside a visible chat");
          const thread = await checkThread(id, context.threadId);

          if (thread.visibility !== "visible" || thread.archivedAt !== null)
            throw new CanvasError("Join from a visible, unarchived chat");

          const link = projects.join({
            projectId: id,
            threadId: thread.id,
            sectionId: input.options.section,
            actor: context.threadId ? "agent" : "human",
            actingThreadId: thread.id,
          });

          service.enable(thread.id, "agent");

          return { link, instructions: brief(thread.id) };
        }),
    }),
    "project section": cliCommand({
      summary: "Create, update, move, lock, archive or restore a section",
      options: mutationOptions,
      positionals: [
        { name: "action", required: true, description: "create, update, move, archive or restore" },
      ],
      run: (input, context) =>
        result(async () => {
          const id = await projectId(input.options.project, context);
          requireJoined(context, id);
          const raw: unknown = JSON.parse(input.options.input);
          const fields = z.record(z.string(), z.unknown()).parse(raw);

          const data = {
            ...fields,
            projectId: id,
            actor: context.threadId ? "agent" : "human",
            actingThreadId: context.threadId,
          };

          switch (input.positionals.action) {
            case "create":
              return createSectionForChat(projectSectionCreateSchema.parse(data), context.threadId);
            case "update":
            case "move":
              return projects.updateSection(projectSectionUpdateSchema.parse(data));
            case "archive":
              return projects.archiveSection(projectSectionActionSchema.parse(data));
            case "restore":
              return projects.restoreSection(projectSectionActionSchema.parse(data));
            default:
              throw new CanvasError("Use create, update, move, archive or restore");
          }
        }),
    }),
    "project view": cliCommand({
      summary: "Save, update, remove, reorder or choose the home view",
      options: {
        ...mutationOptions,
        input: {
          ...mutationOptions.input,
          description:
            "Operation JSON. Free rect: world coordinates; section rect: section-relative; node/island: fit object; chat rect: card-relative offsets.",
        },
      },
      positionals: [
        { name: "action", required: true, description: "put, remove, reorder or home" },
      ],
      run: (input, context) =>
        result(async () => {
          const id = await projectId(input.options.project, context);
          requireJoined(context, id);
          const raw: unknown = JSON.parse(input.options.input);
          const fields = z.record(z.string(), z.unknown()).parse(raw);

          const data = {
            ...fields,
            projectId: id,
            actor: context.threadId ? "agent" : "human",
            actingThreadId: context.threadId,
          };

          switch (input.positionals.action) {
            case "put":
              return projects.putView(projectViewPutSchema.parse(data));
            case "remove":
              return projects.removeView(projectViewRemoveSchema.parse(data));
            case "reorder":
              return projects.reorderViews(projectRpc["project.view.reorder"].input.parse(data));
            case "home":
              return projects.setHome(projectViewRemoveSchema.parse(data));
            default:
              throw new CanvasError("Use put, remove, reorder or home");
          }
        }),
    }),
  };

  api.agents.registerTool({
    name: "canvas_project",
    description:
      "Read this project's canvas, sections, views and chat anchors. Join through the CLI before writing.",
    parameters: z.object({}).strict(),
    execute: (_input, context) => JSON.stringify(projects.get(context.projectId)),
  });
  api.agents.registerTool({
    name: "canvas_section",
    description:
      "List, create, update, move, archive or restore a project section. Join first; locked sections reject agent writes.",
    parameters: z
      .object({
        action: z.enum(["list", "create", "update", "move", "archive", "restore"]),
        input: z.record(z.string(), z.unknown()).optional(),
      })
      .strict(),
    execute: (input, context) => {
      if (input.action === "list") return JSON.stringify(projects.get(context.projectId).sections);
      requireJoined(context, context.projectId);

      const data = {
        ...input.input,
        projectId: context.projectId,
        actor: "agent",
        actingThreadId: context.threadId,
      };

      const value =
        input.action === "create"
          ? createSectionForChat(projectSectionCreateSchema.parse(data), context.threadId)
          : input.action === "archive"
            ? projects.archiveSection(projectSectionActionSchema.parse(data))
            : input.action === "restore"
              ? projects.restoreSection(projectSectionActionSchema.parse(data))
              : projects.updateSection(projectSectionUpdateSchema.parse(data));

      return JSON.stringify(value);
    },
  });
  api.agents.registerTool({
    name: "canvas_view",
    description:
      "List, save, update or remove project canvas views. Join first before writing. Free rectangles use world coordinates; section rectangles are relative to the section. Node and island views fit the object. Chat rectangles are relative to the card.",
    parameters: z
      .object({
        action: z.enum(["list", "put", "remove"]),
        input: z.record(z.string(), z.unknown()).optional(),
      })
      .strict(),
    execute: (input, context) => {
      if (input.action === "list") return JSON.stringify(projects.get(context.projectId).views);
      requireJoined(context, context.projectId);

      const data = {
        ...input.input,
        projectId: context.projectId,
        actor: "agent",
        actingThreadId: context.threadId,
      };

      return JSON.stringify(
        input.action === "put"
          ? projects.putView(projectViewPutSchema.parse(data))
          : projects.removeView(projectViewRemoveSchema.parse(data)),
      );
    },
  });
  api.agents.registerTool({
    name: "canvas_project_add",
    description:
      "Add a chat board from this project as a section, preserving content, sources and history.",
    parameters: z.object({ threadId: z.string().min(1), title: z.string().min(1) }).strict(),
    execute: async (input, context) => {
      await checkThread(context.projectId, input.threadId);

      return JSON.stringify(
        projects.adopt({
          ...input,
          projectId: context.projectId,
          actor: "agent",
          actingThreadId: context.threadId,
        }),
      );
    },
  });

  return { projects, rpc, commands, rpcBoard, agentBoard, brief, checkThread, ensureCanvasChat };
}
