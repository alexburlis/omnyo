import { CanvasError } from "./lib/errors.ts";
import {
  describeBoard,
  describeNode,
  historyRequestSchema,
  sourcePreview,
  historyPreview,
} from "./lib/agent-presentation.ts";
import { byteRange } from "./lib/byte-range.ts";
import { dirname, isAbsolute, join } from "node:path";
import {
  cliCommand,
  defineCli,
  PluginCliError,
  type PluginApi,
  type MessageDispatchHookContext,
  type PluginCliContext,
} from "@omnyo/plugin-sdk";
import { z } from "zod";
import { datasetReadSchema, datasetPage } from "./dataset-reader";
import {
  addInputSchema,
  archiveInputSchema,
  composeInputSchema,
  flowLeaves,
  imageInputSchema,
  editInputSchema,
  linkInputSchema,
  mentionProvider,
  nodeMentionItem,
  nodeMentionProvider,
  parseNodeMentionItem,
  rpcContract,
  toolNames,
  updateInputSchema,
  verifyInputSchema,
} from "./contract.ts";
import { CanvasService } from "./lib/service.ts";
import { MediaService } from "./lib/media.ts";
import { compositionNotes, islandGroups } from "./lib/composition.ts";
import { SourceError, SourceService } from "./lib/sources.ts";
import { boardAddressKey, boardReferenceSchema } from "./board-contract";
import { projectIntegration } from "./project-server";
import { RenderRegistry } from "./lib/inspection.ts";
import {
  sourceIdSchema,
  sourceInputSchema,
  datasetPushInputSchema,
  sourceCredentialInputSchema,
} from "./source-contract.ts";

export { rpcContract } from "./contract.ts";

const guidelines = `- Show actual artifacts, charts and measured results on the board; explanations stay in chat. Use independent HTML/SVG modules with shared Canvas styles, images/videos, code/diffs and deliverable links. Never expose credentials. Do not add goal, status or progress notes: the chat already shows them.
- Resume with canvas_show. Give nodes stable ids and sections. Archive superseded nodes. Name changed nodes in one short chat line.
- Inspect before changing existing modules: canvas_inspect returns authored content, field versions, sources and render evidence. Apply only intended fields with canvas_edit and expectedVersions, then canvas_verify. Missing/stale reports are unverified; open Canvas for current measurements. Human edits are protected. Legacy canvas_update is for agent-owned fields. Use canvas_history, canvas_undo and canvas_redo for attributed, conflict-safe changes.
- For dashboards, use canvas_compose by default after adding independent nodes. Open with one lead takeaway, then group modules into islands: groups with an id and island {title, question, accent}, one reader question each, 3–8 modules, a distinct accent per neighbouring area. Inside an island use flow "bento" (2–4 columns): span the main chart 2, stack short notes beside it, fill every row. Put sources in a quiet footer island with surface "none". Act on the notes compose returns, check each island with canvas_verify({island}), and rearrange one island with canvas_compose({island}). Honor explicit layout requests.
- Design for spatial reading: keep primary evidence and useful comparisons visible. Let readers pan and zoom rather than hide primary views in dropdowns/accordions. Use custom HTML/SVG/CSS/JS and native connectors. Authored views can provide overview/evidence/sources at different zoom levels; stable footprints preserve spatial anchors. Read the Canvas skill for the schema and semantic-zoom rules.
- Use canvas_sources/source/refresh/data for connected, read-only sources and typed module bindings. Keep dates, units, cohorts, provenance and freshness visible. Dataset refreshes preserve authored claims; recheck interpretations when evidence revisions change. Credentials stay in server settings through approved references only. Read the Canvas skill for source and history commands.
- Read the canvas-style skill before composing or polishing a board. Accents identify areas; tone carries status. Module titles state the finding while the island question frames it. No boxes inside islands, no hard-coded colors (use var(--canvas-accent)), provenance once per island. Compare experiments side by side and finish with a Result section containing proof/deliverables.`;

const shellFallback = `- CLI fallback: omnyo canvas show; omnyo canvas add --input-stdin with {"nodes":[…]}; omnyo canvas inspect <id>; omnyo canvas edit --input-stdin with {"id":…, "fields":…, "expectedVersions":…}; omnyo canvas verify <id>; omnyo canvas compose --input-stdin with {"composition":…}; omnyo canvas history; omnyo canvas undo [changeId]; omnyo canvas redo [changeId]. Use quoted JSON heredocs. Read the Canvas skill for links, media and source commands.`;

export const instructions = `Canvas is on for this chat: the user sees a board beside the chat transcript. Keep talking in chat as usual, and use the board to show what you are working on and what you achieved. When you change the board, name the nodes you changed in one short line.
${guidelines}
${shellFallback}`;

export const introduction = `Canvas is now on for this chat: a board sits beside the chat transcript. Start it with this reply: read it with canvas_show (it can hold earlier nodes) and add the artifacts and results from the conversation so far. If there are none yet, leave the board empty until the first one exists. Then add each new artifact or result as you work. Keep replying in chat as usual, and name the nodes you changed in one short line.
${guidelines}
${shellFallback}`;

export const offer = `Prefer Canvas for interactive dashboards built or revised during a chat: run omnyo canvas on and add independent HTML nodes, then use omnyo canvas compose with flow groups by default for dashboards. Group modules into question-led islands beneath a lead takeaway; keep sources quiet. Update nodes in place. Small visuals that fit one reply stay inline in chat. Do not create a separate HTML file for a chat dashboard unless the user asks for a file, download or standalone page. Canvas also helps with nonlinear exploration, relationships, branching experiments and visual comparisons. Leave Canvas off for quick questions, linear investigations and routine coding; task length or several deliverables alone do not justify it. When enabled, keep the board current and show the actual work rather than copying chat or tracking status alone. omnyo canvas on prints the board brief; turn it on whenever the user asks for a board. If this chat continues one with a board, run omnyo canvas move-from <that chat>.`;

const json = { json: { type: "boolean", description: "Print structured JSON" } } as const;

function cliThread(chat: string | undefined, context: PluginCliContext): string {
  const id = !chat || chat === "." ? context.threadId : chat;

  if (!id)
    throw new PluginCliError("Name a chat outside an Omnyo thread", { code: "chat_required" });

  return id;
}

function invokingThread(chat: string | undefined, context: PluginCliContext): string {
  const id = cliThread(chat, context);

  if (id !== context.threadId)
    throw new PluginCliError(
      "Run omnyo canvas on inside the chat, or switch on Canvas in that chat's composer, so its agent learns the board",
      { code: "invoking_chat_required" },
    );

  return id;
}

const continuation = /^Continue from @thread:(thr_[a-z0-9]+)\b/;

function continuedChat(context: MessageDispatchHookContext): string | null {
  const { thread } = context;

  if (
    context.attempt !== "start-turn" ||
    thread.status !== "pending" ||
    thread.parentThreadId !== null ||
    thread.visibility !== "visible"
  )
    return null;

  const chat = continuation.exec(context.input.text)?.[1];

  return chat === undefined || chat === thread.id ? null : chat;
}

function hasCanvasMention(context: MessageDispatchHookContext, pluginId: string): boolean {
  const item = `${mentionProvider.provider}:${mentionProvider.id}`;

  return context.input.blocks.some(
    (block) =>
      block.type === "text" &&
      block.mentions.some(
        (mention) =>
          mention.resource.kind === "plugin" &&
          mention.resource.pluginId === pluginId &&
          mention.resource.itemId === item,
      ),
  );
}

async function readMedia(
  api: PluginApi,
  threadId: string,
  path: string,
  signal: AbortSignal | undefined,
) {
  const thread = await api.sdk.threads.get({ threadId });

  if (!thread.environmentId) throw new CanvasError("This chat has no workspace to read from");

  const environment = await api.sdk.environments.get({ environmentId: thread.environmentId });

  if (!isAbsolute(path) && environment.path === null)
    throw new CanvasError("Use an absolute path; this chat's workspace has no path");

  const absolute = isAbsolute(path) ? path : join(environment.path ?? "", path);

  const file = await api.sdk.files.read({
    hostId: environment.hostId,
    rootPath: dirname(absolute),
    path: absolute,
    signal,
  });

  return Buffer.from(file.content, file.contentEncoding);
}

async function guarded<Result>(run: () => Result | Promise<Result>): Promise<Result> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof CanvasError || error instanceof SourceError)
      throw new PluginCliError(error.message, { code: "canvas" });

    throw error;
  }
}

export default function plugin(api: PluginApi): void {
  const service = new CanvasService(api);
  const media = new MediaService(api);

  api.background.service("canvas-media-preparation", {
    start: (signal) => media.prewarm(signal),
    experimental_stopTimeoutMs: 20_000,
  });
  const sources = new SourceService(api);
  const renders = new RenderRegistry();
  const project = projectIntegration(api, service, sources);
  const { projects, rpcBoard, agentBoard } = project;

  const boardSelector = { board: boardReferenceSchema.optional() };

  const sourceToolSchema = z.union(
    sourceInputSchema.options.map((schema) => schema.extend(boardSelector)),
  );

  function toolBody<Input extends { board?: z.infer<typeof boardReferenceSchema> }>(
    input: Input,
  ): Omit<Input, "board"> {
    const { board: _board, ...body } = input;

    return body;
  }

  function mutateBoard<Change extends { changeId?: string | null }>(
    context: { threadId?: string },
    board: string,
    action: (resolvedBoard: string) => Change,
  ): Change {
    const change = action(board);

    if (context.threadId) projects.recordChange(board, change.changeId, context.threadId);

    return change;
  }

  function requireBoard(threadId: string) {
    const board = service.board(threadId);

    if (board === null)
      throw new CanvasError("Canvas is off. Turn it on before editing or connecting sources.");

    return board;
  }

  function readSources(threadId: string, id?: string) {
    if (id === undefined) return sources.list(threadId).map(sourcePreview);
    const state = sources.get(threadId, id);

    if (!state) throw new SourceError("Source not found");

    return [
      {
        ...sourcePreview(state),
        source: {
          ...state.source,
          definition: sourceInputSchema.parse(state.source.definition),
        },
      },
    ];
  }

  function verifyNode(threadId: string, id: string) {
    const inspection = service.inspect(threadId, id);
    const binding = inspection.node.binding;

    const sourceRevision = binding
      ? (sources.get(threadId, binding.sourceId)?.dataset?.revision ?? null)
      : null;

    const verified = renders.verify(
      threadId,
      inspection.node,
      inspection.boardRevision,
      sourceRevision,
    );

    if (binding) {
      const source = sources.get(threadId, binding.sourceId);

      if (!source?.dataset) verified.issues.push("The bound source has no dataset yet.");

      if (source?.source.status === "error")
        verified.issues.push("The source refresh failed; the displayed dataset is historical.");
    }

    for (const sourceId of inspection.node.evidence?.sourceIds ?? []) {
      const revision = sources.get(threadId, sourceId)?.dataset?.revision;

      if (revision === undefined || inspection.node.evidence?.revisions[sourceId] !== revision)
        verified.issues.push(
          `Interpretation needs review: evidence from ${sourceId} changed or is unavailable.`,
        );
    }

    return verified;
  }

  function verifyIsland(threadId: string, id: string) {
    const board = requireBoard(threadId);

    const island =
      board.composition === null || board.composition === undefined
        ? undefined
        : islandGroups(board.composition.root).find((entry) => entry.id === id);

    if (island === undefined) throw new CanvasError(`No island has id ${id}`);
    const active = new Set(board.nodes.map((node) => node.id));

    const members = flowLeaves(island)
      .filter((leaf) => active.has(leaf.node))
      .map((leaf) => {
        const verified = verifyNode(threadId, leaf.node);

        return { id: leaf.node, current: verified.current, issues: verified.issues };
      });

    const notes = compositionNotes({
      width: board.composition?.width ?? 1200,
      root: { flow: "column", children: [island] },
    }).filter(
      (note) =>
        note.includes(`“${island.island.title}”`) || note.startsWith(`In ${island.island.title},`),
    );

    return {
      island: id,
      title: island.island.title,
      current: members.length > 0 && members.every((member) => member.current),
      members,
      issues: [
        ...new Set([
          ...members.flatMap((member) => member.issues.map((issue) => `${member.id}: ${issue}`)),
          ...notes,
        ]),
      ],
    };
  }

  function inspect(threadId: string, id: string) {
    const inspection = service.inspect(threadId, id);

    const sourceIds = new Set(
      [inspection.node.binding?.sourceId, ...(inspection.node.evidence?.sourceIds ?? [])].filter(
        (value) => value !== undefined,
      ),
    );

    return {
      ...inspection,
      render: verifyNode(threadId, id),
      sources: sources
        .list(threadId)
        .filter((entry) => sourceIds.has(entry.source.definition.id))
        .map(sourcePreview),
    };
  }

  async function reconcileProjects() {
    const current = await api.sdk.projects.list({ includePersonal: true });
    projects.reconcile(current.map((item) => item.id));
  }

  api.background.service("canvas-project-reconciliation", {
    async start(signal) {
      await reconcileProjects();

      if (signal.aborted) return;
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    },
  });
  api.background.schedule("canvas-project-reconciliation", "0 3 * * *", reconcileProjects);

  api.background.schedule("canvas-source-refresh", "* * * * *", () => sources.poll());

  api.rpc.register(rpcContract, {
    ...project.rpc,
    "project.chat.changes": (input) => projects.changesByChat(input.projectId, input.threadId),
    "project.unseen": (input) => ({
      sectionIds: z
        .array(z.object({ id: z.string() }))
        .parse(
          api.storage
            .database()
            .prepare(
              "SELECT r.id FROM canvas_regions r JOIN canvas_threads t ON t.thread_id=r.id WHERE r.project_id=? AND r.archived_at IS NULL AND t.revision>t.seen_revision ORDER BY r.ord,r.id",
            )
            .all(input.projectId),
        )
        .map((row) => row.id),
    }),
    "project.actions": async (input) => {
      const ids = [...new Set(input.threadIds)];

      if (ids.length === 0) return [];

      const threads = await Promise.all(
        ids.map(async (threadId) => {
          try {
            return await api.sdk.threads.get({ threadId });
          } catch (error) {
            if (
              error instanceof Error &&
              "status" in error &&
              error.status === 404 &&
              "code" in error &&
              error.code === "thread_not_found"
            )
              return null;

            throw error;
          }
        }),
      );

      const boards = z.array(z.object({ threadId: z.string() })).parse(
        api.storage
          .database()
          .prepare(
            `SELECT DISTINCT thread_id AS threadId FROM nodes WHERE archived=0 AND thread_id IN (${ids.map(() => "?").join(",")})`,
          )
          .all(...ids),
      );

      const available = new Set(boards.map((board) => board.threadId));

      return threads
        .filter((thread) => thread !== null)
        .map((thread) => {
          const link = projects.link(thread.id);

          const section = link?.regionId
            ? projects.getSection(link.regionId)
            : projects.getSection(projects.resolveBoard(thread.id));

          return {
            threadId: thread.id,
            projectId: thread.projectId,
            boardTitle:
              section === null && available.has(thread.id)
                ? (thread.title ?? thread.titleFallback ?? "Chat board")
                : null,
            link:
              link === null && section === null
                ? null
                : { sectionId: section?.id ?? null, chat: link?.role === "spawned" },
          };
        });
    },
    "project.view.resolve": (input) => {
      const row = api.storage
        .database()
        .prepare(
          input.projectId === undefined
            ? "SELECT project_id AS projectId,id AS viewId FROM canvas_views WHERE id=?"
            : "SELECT project_id AS projectId,id AS viewId FROM canvas_views WHERE id=? AND project_id=?",
        )
        .get(...(input.projectId === undefined ? [input.viewId] : [input.viewId, input.projectId]));

      return row === undefined
        ? null
        : z.object({ projectId: z.string(), viewId: z.string() }).parse(row);
    },
    "project.link": (input) => {
      const link = projects.link(input.threadId);

      const section = link?.regionId
        ? projects.getSection(link.regionId)
        : projects.getSection(projects.resolveBoard(input.threadId));

      return section === null
        ? null
        : { projectId: section.projectId, sectionId: section.id, title: section.title };
    },
    "project.boardProject": async (input) => {
      const thread = await api.sdk.threads.get({ threadId: input.threadId });

      return { projectId: thread.projectId };
    },
    "project.info": async (input) => {
      const item = await api.sdk.projects.get({ projectId: input.projectId });

      return { name: item.name };
    },
    "project.boards": async (input) => {
      const threads = await api.sdk.threads.list({ projectId: input.projectId, limit: 500 });

      if (threads.length === 0) return [];
      const ids = threads.map((thread) => thread.id);

      const counts = z
        .array(z.object({ threadId: z.string(), nodeCount: z.number(), updatedAt: z.number() }))
        .parse(
          api.storage
            .database()
            .prepare(
              `SELECT thread_id AS threadId,COUNT(*) AS nodeCount,MAX(updated_at) AS updatedAt FROM nodes WHERE archived=0 AND thread_id IN (${ids.map(() => "?").join(",")}) GROUP BY thread_id`,
            )
            .all(...ids),
        );

      const byId = new Map(threads.map((thread) => [thread.id, thread]));

      return counts.flatMap((row) => {
        const thread = byId.get(row.threadId);

        return thread === undefined || projects.link(thread.id) !== null
          ? []
          : [{ ...row, title: thread.title ?? thread.titleFallback ?? "Chat board" }];
      });
    },
    "render.report": (input) => {
      const key = rpcBoard(input);

      if (
        input.reports.some((report) => report.sectionId !== undefined && report.sectionId !== key)
      )
        throw new CanvasError("Render report belongs to another section");

      return { accepted: renders.report(key, input.reports, requireBoard(key).nodes) };
    },
    "node.verify": (input) => verifyNode(rpcBoard(input), input.id),
    "node.inspect": (input) => service.inspect(rpcBoard(input), input.id),
    "node.add": (input) => service.add(rpcBoard(input), input.nodes, "human"),
    "node.edit": (input) => {
      const threadId = rpcBoard(input);
      const { board: _board, threadId: _threadId, ...edit } = input;

      return service.edit(threadId, edit, "human");
    },
    "node.duplicate": (input) => service.duplicate(rpcBoard(input), input.id, "human"),
    "board.link": (input) => {
      if (
        input.expectedRevision !== undefined &&
        requireBoard(rpcBoard(input)).revision !== input.expectedRevision
      )
        throw new CanvasError("The board changed. Review the current connections before saving.");

      return service.link(
        rpcBoard(input),
        input.from,
        input.to,
        input.label,
        input.remove === true,
        "human",
        input.expectedRevision,
      );
    },
    "board.history": (input) => service.history(rpcBoard(input)),
    "board.historySummary": (input) =>
      service.historySummary(rpcBoard(input), input.limit, input.offset),
    "board.historyDetail": (input) => service.historyDetail(rpcBoard(input), input.changeId),
    "board.undo": (input) => service.undo(rpcBoard(input), input.changeId, "human"),
    "board.redo": (input) => service.redo(rpcBoard(input), input.changeId, "human"),
    "source.list": (input) => {
      requireBoard(rpcBoard(input));

      return { sources: sources.list(rpcBoard(input)) };
    },
    "source.put": (input) => {
      requireBoard(rpcBoard(input));

      return sources.upsert(rpcBoard(input), input.source);
    },
    "source.refresh": (input) => {
      requireBoard(rpcBoard(input));

      return sources.refresh(rpcBoard(input), input.id);
    },
    "source.pause": (input) => {
      requireBoard(rpcBoard(input));

      return sources.pause(rpcBoard(input), input.id, input.paused);
    },
    "source.push": (input) => {
      requireBoard(rpcBoard(input));

      return sources.push(rpcBoard(input), input);
    },
    "source.credential": (input) => {
      requireBoard(rpcBoard(input));

      return sources.importCredential(rpcBoard(input), input);
    },
    "mode.get": (input) => {
      const status = service.status(boardAddressKey(input));

      return status.canvas ? service.status(rpcBoard(input)) : status;
    },
    "mode.off": (input) => {
      const literal = boardAddressKey(input);

      if (literal.startsWith("sec_"))
        throw new CanvasError("Archive a project section instead of turning its board off");

      return service.disable(literal);
    },
    "workspace.get": async (input) => {
      const thread = await api.sdk.threads.get({ threadId: input.threadId });

      if (!thread.environmentId) return { environmentId: null, hostId: null };

      const environment = await api.sdk.environments.get({ environmentId: thread.environmentId });

      return { environmentId: environment.id, hostId: environment.hostId };
    },
    "board.get": (input) => ({ board: service.board(rpcBoard(input)) }),
    "board.compose": (input) => service.compose(rpcBoard(input), input, "human"),
    "board.markSeen": (input) => service.markSeen(rpcBoard(input), input.revision),
    "node.move": (input) => service.move(rpcBoard(input), input.id, input.position, "human"),
    "node.pin": (input) => service.pin(rpcBoard(input), input.id, input.pinned, "human"),
    "node.archive": (input) => service.archive(rpcBoard(input), [input.id], "human"),
  });

  api.ui.registerMentionProvider({
    id: mentionProvider.provider,
    label: "Display",
    search: () => [],
    resolve: () => ({ context: introduction }),
  });

  api.ui.registerMentionProvider({
    id: "conversation",
    label: "Canvas conversation",
    search: () => [],
    resolve: (itemId) => {
      const { threadId, nodeId: id } = parseNodeMentionItem(itemId);

      const node = service
        .board(projects.resolveBoard(threadId))
        ?.nodes.find((entry) => entry.conversation?.id === id);

      if (!node) throw new CanvasError("That Canvas conversation no longer exists");

      return {
        context: `This prompt belongs to Canvas conversation ${id}. Your answer appears connected to this prompt in its fenced board region. Continue using this chat's context and tools. When referring to another board module, use a Markdown link [module title](#canvas-node-MODULE_ID), replacing MODULE_ID with its exact existing node id. Link each module you edit so the user can move to it. Keep the conversation node in place.`,
      };
    },
  });

  api.ui.registerMentionProvider({
    id: nodeMentionProvider,
    label: "Board",
    search: (context) => {
      if (context.threadId === null) return [];

      const board = service.board(projects.resolveBoard(context.threadId));

      if (board === null) return [];

      const query = context.query.toLowerCase();

      return board.nodes
        .filter((node) => `${node.id} ${node.title ?? ""}`.toLowerCase().includes(query))
        .slice(0, 20)
        .map((node) => ({
          id: nodeMentionItem(board.threadId, node.id),
          title: node.title ?? node.id,
          subtitle: `${node.section} · ${node.kind}`,
          icon: "GridView",
        }));
    },
    resolve: (itemId) => {
      const reference = parseNodeMentionItem(itemId);

      const node = service
        .board(projects.resolveBoard(reference.threadId))
        ?.nodes.find((entry) => entry.id === reference.nodeId);

      if (node === undefined) throw new CanvasError("That board node no longer exists");

      return { context: describeNode(node) };
    },
  });

  function carryBoard(context: MessageDispatchHookContext) {
    const from = continuedChat(context);

    if (from === null) return;
    const to = context.thread.id;

    try {
      if (projects.inheritLink(from, to) !== null) {
        service.enable(to, "agent");

        return;
      }

      if (service.hasLiveBoard(from)) service.moveBoard(from, to, () => sources.move(from, to));
    } catch (error) {
      api.log.warn(
        `Canvas kept the board in ${from} instead of moving it to ${to}: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }

  function returnBoard(threadId: string) {
    try {
      const home = service.returnTarget(threadId);

      if (home !== null) service.returnBoard(threadId, home, () => sources.move(threadId, home));
    } catch (error) {
      api.log.warn(
        `Canvas could not return the board of deleted chat ${threadId}: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }

  api.experimental_hooks.on("message.dispatch", async (context) => {
    await project.ensureCanvasChat(context.thread);
    carryBoard(context);

    if (hasCanvasMention(context, api.pluginId)) service.enable(context.thread.id, "user");

    return { action: "proceed" };
  });

  api.agents.configure((context) =>
    project.brief(context.thread.id) !== null
      ? {
          tools: [
            ...Object.values(toolNames),
            "canvas_project",
            "canvas_section",
            "canvas_view",
            "canvas_project_add",
          ],
          skills: ["canvas", "canvas-style"],
          instructions: project.brief(context.thread.id) ?? instructions,
        }
      : service.isCanvas(context.thread.id)
        ? { tools: Object.values(toolNames), skills: ["canvas", "canvas-style"], instructions }
        : {
            tools: [],
            skills: [],
            instructions:
              projects.get(context.project.id).revision > 0
                ? `${offer} This project has a canvas. Read it with omnyo canvas project show; join before writing with omnyo canvas project join.`
                : offer,
          },
  );

  api.agents.registerTool({
    name: toolNames.inspect,
    description:
      "Inspect one selected module: complete authored content, current field versions, connected source data and current/stale render measurements.",
    parameters: z
      .object({ id: z.string().min(1).max(40) })
      .strict()
      .extend(boardSelector),
    execute: (input, context) =>
      JSON.stringify(inspect(agentBoard(context, input.board, false), input.id)),
  });
  api.agents.registerTool({
    name: toolNames.edit,
    description:
      "Apply a guarded, undoable edit using expectedVersions returned by canvas_inspect. Only touched fields change; stale or human-protected fields require a fresh inspection.",
    parameters: editInputSchema.safeExtend(boardSelector),
    execute: (input, context) =>
      JSON.stringify(
        mutateBoard(context, agentBoard(context, input.board, true), (resolvedBoard) =>
          service.edit(resolvedBoard, toolBody(input), "agent"),
        ),
      ),
  });
  api.agents.registerTool({
    name: toolNames.verify,
    description:
      "Check a module's (id) or a whole island's (island) current connected render for overflow, overlap, bento gaps and readiness. Missing or stale render reports are explicitly unverified.",
    parameters: verifyInputSchema.safeExtend(boardSelector),
    execute: (input, context) =>
      JSON.stringify(
        input.island === undefined
          ? verifyNode(agentBoard(context, input.board, false), input.id ?? "")
          : verifyIsland(agentBoard(context, input.board, false), input.island),
      ),
  });
  api.agents.registerTool({
    name: toolNames.history,
    description:
      "Read the latest10 attributed edits with bounded field summaries; request changeId for full paged field detail.",
    parameters: historyRequestSchema.safeExtend(boardSelector),
    execute: (input, context) =>
      JSON.stringify(
        historyPreview(service.history(agentBoard(context, input.board, false)), input),
      ),
  });

  for (const action of ["undo", "redo"] as const)
    api.agents.registerTool({
      name: toolNames[action],
      description: `${action === "undo" ? "Undo" : "Redo"} one authored change without overwriting later work. Same-field conflicts fail visibly.`,
      parameters: z.object({ changeId: z.string().optional() }).strict().extend(boardSelector),
      execute: (input, context) =>
        JSON.stringify(
          mutateBoard(context, agentBoard(context, input.board, true), (resolvedBoard) =>
            service[action](resolvedBoard, input.changeId, "agent"),
          ),
        ),
    });
  api.agents.registerTool({
    name: toolNames.sources,
    description:
      "List source metadata and freshness with small dataset previews. Supply id to read one complete saved source definition for editing. Protected credentials are never returned.",
    parameters: z.object({ id: sourceIdSchema.optional() }).strict().extend(boardSelector),
    execute: (input, context) => {
      requireBoard(agentBoard(context, input.board, false));

      return JSON.stringify(readSources(agentBoard(context, input.board, false), input.id));
    },
  });
  api.agents.registerTool({
    name: toolNames.source,
    description:
      "Configure a read-only API or agent-pushed dataset source. Default interval0 is manual; positive intervals enable bounded polling. Declare source windows, units and cohorts.",
    parameters: sourceToolSchema,
    execute: (input, context) => {
      requireBoard(agentBoard(context, input.board, true));

      return JSON.stringify(
        sourcePreview(
          sources.upsert(
            agentBoard(context, input.board, true),
            sourceInputSchema.parse(toolBody(input)),
          ),
        ),
      );
    },
  });
  api.agents.registerTool({
    name: toolNames.refresh,
    description:
      "Refresh a configured source once. Preserves authored titles, layout and interpretations. Failures retain explicitly historical data.",
    parameters: z
      .object({ id: z.string().min(1).max(40) })
      .strict()
      .extend(boardSelector),
    execute: async (input, context) => {
      requireBoard(agentBoard(context, input.board, true));

      return JSON.stringify(
        sourcePreview(
          await sources.refresh(agentBoard(context, input.board, true), input.id, context.signal),
        ),
      );
    },
  });
  api.agents.registerTool({
    name: toolNames.dataset,
    description:
      "Read a source dataset with explicit bounded pagination and selected columns. Supply expectedRevision on later pages to avoid mixing refreshed data.",
    parameters: datasetReadSchema.safeExtend(boardSelector),
    execute: (input, context) => {
      requireBoard(agentBoard(context, input.board, false));
      const dataset = sources.get(agentBoard(context, input.board, false), input.sourceId)?.dataset;

      if (!dataset) throw new SourceError("This source has no dataset yet");

      return JSON.stringify(datasetPage(dataset, input));
    },
  });
  api.agents.registerTool({
    name: toolNames.data,
    description:
      "Publish bounded scalar rows into a manual source from any authorized collector. Values stay separate from authored board state; provenance is required for meaningful comparison.",
    parameters: datasetPushInputSchema.safeExtend(boardSelector),
    execute: (input, context) => {
      requireBoard(agentBoard(context, input.board, true));

      return JSON.stringify(
        sourcePreview(sources.push(agentBoard(context, input.board, true), toolBody(input))),
      );
    },
  });
  api.agents.registerTool({
    name: toolNames.credential,
    description:
      "Import an approved 1Password reference (op://vault/item/field) into server-only source settings through the local 1Password CLI. Accepts references only; returns no credential. The slot's approved reference and HTTPS origin must already be set in Canvas settings.",
    parameters: sourceCredentialInputSchema.safeExtend(boardSelector),
    execute: async (input, context) => {
      requireBoard(agentBoard(context, input.board, true));

      return JSON.stringify(
        await sources.importCredential(agentBoard(context, input.board, true), toolBody(input)),
      );
    },
  });
  api.agents.registerTool({
    name: toolNames.show,
    description: "Read this chat's Canvas board: sections, node ids, kinds, states and links.",
    parameters: z.object({}).strict().extend(boardSelector),
    execute: (input, context) =>
      describeBoard(service.board(agentBoard(context, input.board, false))),
  });
  api.agents.registerTool({
    name: toolNames.add,
    description:
      "Add 1–20 nodes to this chat's Canvas board. Give each a short stable id, a section and optionally after (order after that node).",
    parameters: addInputSchema.safeExtend(boardSelector),
    presentation: {
      label: { pending: "Adding to the board", completed: "Added to the board" },
      icon: { glyph: "GridView" },
    },
    execute: (input, context) =>
      JSON.stringify(
        mutateBoard(context, agentBoard(context, input.board, true), (resolvedBoard) =>
          service.add(resolvedBoard, input.nodes),
        ),
      ),
  });
  api.agents.registerTool({
    name: toolNames.update,
    description:
      "Update agent-owned fields in place. Human-owned fields require canvas_inspect then canvas_edit with current expectedVersions. Prefer that guarded workflow for existing modules.",
    parameters: updateInputSchema.safeExtend(boardSelector),
    presentation: {
      label: { pending: "Updating the board", completed: "Updated the board" },
      icon: { glyph: "GridView" },
    },
    execute: (input, context) =>
      JSON.stringify(
        mutateBoard(context, agentBoard(context, input.board, true), (resolvedBoard) =>
          service.update(resolvedBoard, updateInputSchema.parse(toolBody(input))),
        ),
      ),
  });
  api.agents.registerTool({
    name: toolNames.compose,
    description:
      "Arrange existing nodes. Send composition for the whole board (nested row, column, wrap or bento groups; islands are groups with id and island {title, question, accent}), or island to replace or add one island in place (after positions a new one). Returns design notes to act on. composition null restores sections; resetPositions clears referenced manual placement.",
    parameters: composeInputSchema.safeExtend(boardSelector),
    execute: (input, context) =>
      JSON.stringify(
        mutateBoard(context, agentBoard(context, input.board, true), (resolvedBoard) =>
          service.compose(resolvedBoard, toolBody(input)),
        ),
      ),
  });
  api.agents.registerTool({
    name: toolNames.link,
    description:
      "Connect two nodes on this chat's Canvas board with an optional short label, or remove the link.",
    parameters: linkInputSchema.safeExtend(boardSelector),
    execute: (input, context) =>
      JSON.stringify(
        mutateBoard(context, agentBoard(context, input.board, true), (resolvedBoard) =>
          service.link(
            resolvedBoard,
            input.from,
            input.to,
            input.label,
            input.remove === true,
            "agent",
            input.expectedRevision,
          ),
        ),
      ),
  });
  api.agents.registerTool({
    name: toolNames.archive,
    description: "Hide superseded nodes from this chat's Canvas board.",
    parameters: archiveInputSchema.safeExtend(boardSelector),
    execute: (input, context) =>
      JSON.stringify(
        mutateBoard(context, agentBoard(context, input.board, true), (resolvedBoard) =>
          service.archive(resolvedBoard, input.ids),
        ),
      ),
  });
  api.agents.registerTool({
    name: toolNames.image,
    description:
      "Store an image or video (PNG, JPEG, GIF, WebP, MP4, MOV or WebM, 20 MiB) from the workspace (relative or absolute path) and add it to this chat's Canvas board as a wide image or video node.",
    parameters: imageInputSchema.safeExtend(boardSelector),
    presentation: {
      label: { pending: "Adding media to the board", completed: "Added media to the board" },
      icon: { glyph: "Image" },
    },
    async execute(input, context) {
      const { path, ...node } = toolBody(input);
      const bytes = await readMedia(api, context.threadId, path, context.signal);

      const result = mutateBoard(context, agentBoard(context, input.board, true), (resolvedBoard) =>
        service.addMedia(resolvedBoard, bytes, node),
      );

      const assetId = service
        .board(agentBoard(context, input.board, true))
        ?.nodes.find((entry) => entry.id === result.id)?.assetId;

      if (assetId && media.isImage(assetId)) await media.prepare(assetId);

      return JSON.stringify(result);
    },
  });

  api.http.route("GET", "/asset-info", async (c) => {
    const id = c.req.query("id") ?? "";

    if (!/^[a-f0-9]{64}$/u.test(id)) return c.json({ error: "Invalid asset ID" }, 400);

    if (!media.exists(id)) return c.json({ error: "Asset not found" }, 404);

    try {
      return c.json(await media.prepare(id), 200, {
        "Cache-Control": "private, max-age=31536000, immutable",
      });
    } catch (error) {
      api.log.warn(
        JSON.stringify({
          message: "Canvas image preview could not be prepared",
          assetId: id,
          detail: error instanceof Error ? error.message : "Image preparation failed",
        }),
      );

      return c.json({ error: "Image preview could not be prepared. Try again." }, 503);
    }
  });

  api.http.route("GET", "/asset", (c) => {
    const id = c.req.query("id") ?? "";

    if (!/^[a-f0-9]{64}$/u.test(id)) return c.text("Invalid asset ID", 400);

    const width = c.req.query("width");

    if (width !== undefined && !/^[1-9][0-9]{0,4}$/u.test(width))
      return c.text("Invalid image width", 400);
    const requestedWidth = width === undefined ? undefined : Number(width);
    const metadata = service.assetMetadata(id, requestedWidth);

    if (metadata === null) return c.text("Asset not found", 404);

    const headers = {
      "Content-Type": metadata.mime,
      "Accept-Ranges": "bytes",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, max-age=31536000, immutable",
      "Content-Security-Policy": "default-src 'none'; img-src 'self'; media-src 'self'; sandbox",
      "Content-Disposition": "inline",
    };

    const total = metadata.byteLength;
    const range = byteRange(c.req.header("range"), total);

    if (range === "unsatisfiable")
      return new Response(null, {
        status: 416,
        headers: { ...headers, "Content-Range": `bytes */${total}` },
      });

    const asset = service.asset(id, range, requestedWidth);

    if (asset === null) return c.text("Asset not found", 404);

    return new Response(new Uint8Array(asset.content), {
      status: range === null ? 200 : 206,
      headers:
        range === null
          ? headers
          : { ...headers, "Content-Range": `bytes ${range.start}-${range.end}/${total}` },
    });
  });

  api.events.on("thread.created", async ({ thread }) => project.ensureCanvasChat(thread));

  for (const event of ["thread.archived", "thread.unarchived"] as const)
    api.events.on(event, ({ thread }) => {
      const link = projects.link(thread.id);

      if (link?.role === "spawned")
        projects.resolveChat({
          projectId: link.projectId,
          threadId: thread.id,
          resolved: event === "thread.archived",
          actor: "system",
        });
    });

  api.events.on("thread.deleted", ({ thread }) => {
    if (projects.removeThread(thread.id)) {
      service.remove(thread.id);

      return;
    }

    returnBoard(thread.id);
    sources.remove(thread.id);
    service.remove(thread.id);
  });

  function cliBoard(
    chat: string | undefined,
    context: PluginCliContext,
    write = false,
    selection?: { section?: string; project?: string },
  ): string {
    if (
      write &&
      selection?.section === undefined &&
      context.threadId &&
      projects.link(context.threadId)?.regionId === null
    )
      throw new CanvasError("Create a project section first, then add modules to it");

    const key = projects.resolveBoard(
      selection?.section ? { sectionId: selection.section } : cliThread(chat, context),
    );

    const id = projects.boardProject(key);

    if (selection?.project !== undefined && selection.project !== id)
      throw new CanvasError("That section does not belong to the selected project");

    if (
      write &&
      id !== null &&
      context.threadId &&
      (projects.link(context.threadId)?.projectId !== id ||
        (context.projectId !== undefined && context.projectId !== id))
    )
      throw new CanvasError("Join this project canvas before writing to its sections");

    if (write) projects.assertWritable(key, context.threadId ? "agent" : "human");

    return key;
  }

  const chat = [{ name: "chat", description: "Chat ID, or . for the invoking chat" }] as const;

  const selectionOptions = {
    section: { type: "string", description: "Target project canvas section ID" },
    project: {
      type: "string",
      description: "Require the target section to belong to this project",
    },
  } as const;

  const stdinJson = (description: string) =>
    ({
      ...json,
      ...selectionOptions,
      chat: { type: "string", description: "Target chat ID; defaults to the invoking chat" },
      input: { type: "string", required: true, stdin: true, description },
    }) as const;

  const targetOptions = {
    ...json,
    ...selectionOptions,
    chat: { type: "string", description: "Target chat ID; defaults to the invoking chat" },
  } as const;

  const identified = [{ name: "id", description: "Module or source ID", required: true }] as const;

  const change = [
    { name: "changeId", description: "History change ID; defaults to the latest eligible change" },
  ] as const;

  api.cli.register(
    defineCli({
      name: "canvas",
      summary: "Turn Canvas on or off and change a chat's board",
      commands: {
        ...project.commands,
        on: cliCommand({
          summary: "Turn on Canvas for the invoking chat and print how to build the board",
          positionals: chat,
          options: json,
          run(input, context) {
            const threadId = invokingThread(input.positionals.chat, context);
            const changed = service.enable(threadId, "agent");

            return {
              exitCode: 0,
              stdout: input.options.json
                ? JSON.stringify({ ...service.status(threadId), changed, introduction })
                : introduction,
            };
          },
        }),
        "move-from": cliCommand({
          summary:
            "Move another chat's board into the invoking chat with its layout, history and sources",
          positionals: [
            { name: "chat", description: "Chat whose board moves here", required: true },
          ],
          options: json,
          run(input, context) {
            return guarded(() => {
              const threadId = invokingThread(undefined, context);
              const from = z.string().min(1).parse(input.positionals.chat);
              const moved = service.moveBoard(from, threadId, () => sources.move(from, threadId));

              return {
                exitCode: 0,
                stdout: input.options.json
                  ? JSON.stringify({ ...moved, instructions })
                  : `Moved the board from ${from}: ${moved.modules} modules and ${moved.sources} sources, with their layout and undo history. Canvas is on here; the other chat keeps Canvas off.\n\n${instructions}`,
              };
            });
          },
        }),
        off: cliCommand({
          summary: "Turn off Canvas for a chat; its board is kept for when Canvas is on again",
          positionals: chat,
          options: json,
          run(input, context) {
            const mode = service.disable(cliThread(input.positionals.chat, context));

            return {
              exitCode: 0,
              stdout: input.options.json
                ? JSON.stringify(mode)
                : "Canvas is off for this chat. Its board comes back when Canvas is on again.",
            };
          },
        }),
        show: cliCommand({
          summary: "Show a Canvas chat's board or project section",
          positionals: chat,
          options: { ...json, ...selectionOptions },
          run(input, context) {
            const board = service.board(
              cliBoard(input.positionals.chat, context, false, {
                section: input.options.section,
                project: input.options.project,
              }),
            );

            return {
              exitCode: 0,
              stdout: input.options.json ? JSON.stringify({ board }) : describeBoard(board),
            };
          },
        }),
        inspect: cliCommand({
          summary:
            "Inspect authored content, versions, source previews and connected render evidence",
          positionals: identified,
          options: targetOptions,
          run(input, context) {
            return guarded(() => ({
              exitCode: 0,
              stdout: JSON.stringify(
                inspect(
                  cliBoard(input.options.chat, context, false, {
                    section: input.options.section,
                    project: input.options.project,
                  }),
                  input.positionals.id,
                ),
              ),
            }));
          },
        }),
        edit: cliCommand({
          summary: "Apply an inspected, undoable field edit with expectedVersions",
          options: stdinJson('JSON {"id":…, "fields":…, "expectedVersions":…}'),
          run(input, context) {
            return guarded(() => ({
              exitCode: 0,
              stdout: JSON.stringify(
                mutateBoard(
                  context,
                  cliBoard(input.options.chat, context, true, {
                    section: input.options.section,
                    project: input.options.project,
                  }),
                  (resolvedBoard) =>
                    service.edit(
                      resolvedBoard,
                      editInputSchema.parse(JSON.parse(input.options.input)),
                      "agent",
                    ),
                ),
              ),
            }));
          },
        }),
        verify: cliCommand({
          summary:
            "Check a module's or an island's current geometry, bento gaps, source revision and readiness",
          positionals: [{ name: "id", description: "Module ID; omit with --island" }],
          options: {
            ...targetOptions,
            island: { type: "string", description: "Island ID to verify as a whole" },
          },
          run(input, context) {
            return guarded(() => {
              const parsed = verifyInputSchema.parse({
                id: input.positionals.id,
                island: input.options.island,
              });

              const thread = cliBoard(input.options.chat, context, false, {
                section: input.options.section,
                project: input.options.project,
              });

              return {
                exitCode: 0,
                stdout: JSON.stringify(
                  parsed.island === undefined
                    ? verifyNode(thread, parsed.id ?? "")
                    : verifyIsland(thread, parsed.island),
                ),
              };
            });
          },
        }),
        history: cliCommand({
          summary: "Read recent edits; request a change ID for full paged field detail",
          positionals: [{ name: "limit", description: "Recent entries, 1–20; defaults to10" }],
          options: {
            ...targetOptions,
            change: {
              type: "string",
              aliases: ["change-id"],
              description: "Change ID for full field detail",
            },
            "field-offset": {
              type: "integer",
              min: 0,
              max: 10000,
              default: 0,
              description: "Field offset for the next full-detail page",
            },
          },
          run(input, context) {
            return guarded(() => {
              const request = historyRequestSchema.parse({
                limit:
                  input.positionals.limit === undefined
                    ? 10
                    : z.coerce.number().parse(input.positionals.limit),
                changeId: input.options.change,
                fieldOffset: input.options["field-offset"],
              });

              return {
                exitCode: 0,
                stdout: JSON.stringify(
                  historyPreview(
                    service.history(
                      cliBoard(input.options.chat, context, false, {
                        section: input.options.section,
                        project: input.options.project,
                      }),
                    ),
                    request,
                  ),
                ),
              };
            });
          },
        }),
        undo: cliCommand({
          summary: "Undo one authored change without overwriting later fields",
          positionals: change,
          options: targetOptions,
          run(input, context) {
            return guarded(() => ({
              exitCode: 0,
              stdout: JSON.stringify(
                mutateBoard(
                  context,
                  cliBoard(input.options.chat, context, true, {
                    section: input.options.section,
                    project: input.options.project,
                  }),
                  (resolvedBoard) =>
                    service.undo(resolvedBoard, input.positionals.changeId, "agent"),
                ),
              ),
            }));
          },
        }),
        redo: cliCommand({
          summary: "Redo one undone change without overwriting later fields",
          positionals: change,
          options: targetOptions,
          run(input, context) {
            return guarded(() => ({
              exitCode: 0,
              stdout: JSON.stringify(
                mutateBoard(
                  context,
                  cliBoard(input.options.chat, context, true, {
                    section: input.options.section,
                    project: input.options.project,
                  }),
                  (resolvedBoard) =>
                    service.redo(resolvedBoard, input.positionals.changeId, "agent"),
                ),
              ),
            }));
          },
        }),
        duplicate: cliCommand({
          summary: "Copy a module with its authored views and source binding",
          positionals: identified,
          options: targetOptions,
          run(input, context) {
            return guarded(() => ({
              exitCode: 0,
              stdout: JSON.stringify(
                mutateBoard(
                  context,
                  cliBoard(input.options.chat, context, true, {
                    section: input.options.section,
                    project: input.options.project,
                  }),
                  (resolvedBoard) =>
                    service.duplicate(resolvedBoard, input.positionals.id, "agent"),
                ),
              ),
            }));
          },
        }),
        dataset: cliCommand({
          summary: "Read bounded pages from a source dataset",
          positionals: [{ name: "source", required: true, description: "Source ID" }],
          options: {
            ...targetOptions,
            offset: {
              type: "integer",
              min: 0,
              max: Number.MAX_SAFE_INTEGER,
              default: 0,
              description: "First row",
            },
            limit: { type: "integer", min: 1, max: 200, default: 50, description: "Maximum rows" },
            columns: { type: "string", description: "Comma-separated column keys" },
            "expected-revision": {
              type: "integer",
              min: 0,
              max: Number.MAX_SAFE_INTEGER,
              description: "Require this content revision",
            },
          },
          run(input, context) {
            return guarded(() => {
              const threadId = cliBoard(input.options.chat, context, false, {
                section: input.options.section,
                project: input.options.project,
              });

              requireBoard(threadId);

              const parsed = datasetReadSchema.parse({
                sourceId: input.positionals.source,
                offset: input.options.offset,
                limit: input.options.limit,
                columns: input.options.columns?.split(",").map((key) => key.trim()),
                expectedRevision: input.options["expected-revision"],
              });

              const dataset = sources.get(threadId, parsed.sourceId)?.dataset;

              if (!dataset) throw new SourceError("This source has no dataset yet");

              return { exitCode: 0, stdout: JSON.stringify(datasetPage(dataset, parsed)) };
            });
          },
        }),
        sources: cliCommand({
          summary: "List source metadata; --source ID includes one complete saved definition",
          positionals: chat,
          options: {
            ...json,
            ...selectionOptions,
            source: { type: "string", description: "Read this source's full public configuration" },
          },
          run(input, context) {
            return guarded(() => {
              const threadId = cliBoard(input.positionals.chat, context, false, {
                section: input.options.section,
                project: input.options.project,
              });

              requireBoard(threadId);
              const id = sourceIdSchema.optional().parse(input.options.source);

              return {
                exitCode: 0,
                stdout: JSON.stringify({ sources: readSources(threadId, id) }),
              };
            });
          },
        }),
        source: cliCommand({
          summary:
            "Configure a manual, JSON, MCP, Google Search Console, PostHog or Cloudflare source",
          options: stdinJson("SourceInput JSON; provider configuration and provenance"),
          run(input, context) {
            return guarded(() => {
              const threadId = cliBoard(input.options.chat, context, true, {
                section: input.options.section,
                project: input.options.project,
              });

              requireBoard(threadId);

              return {
                exitCode: 0,
                stdout: JSON.stringify(
                  sourcePreview(
                    sources.upsert(
                      threadId,
                      sourceInputSchema.parse(JSON.parse(input.options.input)),
                    ),
                  ),
                ),
              };
            });
          },
        }),
        refresh: cliCommand({
          summary: "Refresh a source once and return freshness plus a small preview",
          positionals: identified,
          options: targetOptions,
          run(input, context) {
            return guarded(async () => {
              const threadId = cliBoard(input.options.chat, context, true, {
                section: input.options.section,
                project: input.options.project,
              });

              requireBoard(threadId);

              return {
                exitCode: 0,
                stdout: JSON.stringify(
                  sourcePreview(
                    await sources.refresh(threadId, input.positionals.id, context.signal),
                  ),
                ),
              };
            });
          },
        }),
        data: cliCommand({
          summary: "Push scalar dataset rows into a configured manual source",
          options: stdinJson("DatasetPushInput JSON; sourceId, columns, rows and provenance"),
          run(input, context) {
            return guarded(() => {
              const threadId = cliBoard(input.options.chat, context, true, {
                section: input.options.section,
                project: input.options.project,
              });

              requireBoard(threadId);

              return {
                exitCode: 0,
                stdout: JSON.stringify(
                  sourcePreview(
                    sources.push(
                      threadId,
                      datasetPushInputSchema.parse(JSON.parse(input.options.input)),
                    ),
                  ),
                ),
              };
            });
          },
        }),
        "source-credential": cliCommand({
          summary: "Import an approved 1Password reference; raw credentials are rejected",
          options: stdinJson("Reference-only JSON with slot, reference and optional origin"),
          run(input, context) {
            return guarded(async () => {
              const threadId = cliBoard(input.options.chat, context, true, {
                section: input.options.section,
                project: input.options.project,
              });

              requireBoard(threadId);

              return {
                exitCode: 0,
                stdout: JSON.stringify(
                  await sources.importCredential(
                    threadId,
                    sourceCredentialInputSchema.parse(JSON.parse(input.options.input)),
                  ),
                ),
              };
            });
          },
        }),
        add: cliCommand({
          summary: 'Add nodes: --input-stdin with {"nodes":[…]}',
          options: stdinJson('JSON {"nodes":[…]}, or --input-stdin for piped JSON'),
          run(input, context) {
            return guarded(async () => {
              const parsed = addInputSchema.parse(JSON.parse(input.options.input));

              return {
                exitCode: 0,
                stdout: JSON.stringify(
                  mutateBoard(
                    context,
                    cliBoard(input.options.chat, context, true, {
                      section: input.options.section,
                      project: input.options.project,
                    }),
                    (resolvedBoard) => service.add(resolvedBoard, parsed.nodes),
                  ),
                ),
              };
            });
          },
        }),
        update: cliCommand({
          summary: 'Update one node: --input-stdin with {"id":…, fields}',
          options: stdinJson('JSON {"id":…}, or --input-stdin for piped JSON'),
          run(input, context) {
            return guarded(async () => {
              const parsed = updateInputSchema.parse(JSON.parse(input.options.input));

              return {
                exitCode: 0,
                stdout: JSON.stringify(
                  mutateBoard(
                    context,
                    cliBoard(input.options.chat, context, true, {
                      section: input.options.section,
                      project: input.options.project,
                    }),
                    (resolvedBoard) => service.update(resolvedBoard, parsed),
                  ),
                ),
              };
            });
          },
        }),
        compose: cliCommand({
          summary:
            'Arrange nodes: --input-stdin with {"composition":{"width":1200,"root":{...}}} or {"island":{"id":…,"flow":"bento","island":{"title":…},"children":[…]}}',
          options: stdinJson(
            'JSON {"composition":…} or {"island":…,"after":…}, or --input-stdin for piped JSON',
          ),
          run(input, context) {
            return guarded(async () => {
              const parsed = composeInputSchema.parse(JSON.parse(input.options.input));

              return {
                exitCode: 0,
                stdout: JSON.stringify(
                  mutateBoard(
                    context,
                    cliBoard(input.options.chat, context, true, {
                      section: input.options.section,
                      project: input.options.project,
                    }),
                    (resolvedBoard) => service.compose(resolvedBoard, parsed),
                  ),
                ),
              };
            });
          },
        }),
        link: cliCommand({
          summary: "Link two nodes, or remove the link with --remove",
          positionals: [
            { name: "from", description: "Source node id", required: true },
            { name: "to", description: "Target node id", required: true },
          ],
          options: {
            ...json,
            chat: { type: "string", description: "Target chat ID; defaults to the invoking chat" },
            ...selectionOptions,
            label: { type: "string", description: "Short link label" },
            remove: { type: "boolean", description: "Remove the link" },
            "expected-revision": {
              type: "integer",
              min: 0,
              max: Number.MAX_SAFE_INTEGER,
              description: "Require the current board revision",
            },
          },
          run(input, context) {
            return guarded(async () => {
              const parsed = linkInputSchema.parse({
                from: input.positionals.from,
                to: input.positionals.to,
                label: input.options.label,
                remove: input.options.remove,
                expectedRevision: input.options["expected-revision"],
              });

              return {
                exitCode: 0,
                stdout: JSON.stringify(
                  mutateBoard(
                    context,
                    cliBoard(input.options.chat, context, true, {
                      section: input.options.section,
                      project: input.options.project,
                    }),
                    (resolvedBoard) =>
                      service.link(
                        resolvedBoard,
                        parsed.from,
                        parsed.to,
                        parsed.label,
                        parsed.remove === true,
                        "agent",
                        parsed.expectedRevision,
                      ),
                  ),
                ),
              };
            });
          },
        }),
        archive: cliCommand({
          summary: "Hide nodes from the board",
          positionals: [{ name: "ids", description: "Node ids", required: true, variadic: true }],
          options: {
            ...json,
            ...selectionOptions,
            chat: { type: "string", description: "Target chat ID; defaults to the invoking chat" },
          },
          run(input, context) {
            return guarded(async () => {
              const parsed = archiveInputSchema.parse({ ids: input.positionals.ids });

              return {
                exitCode: 0,
                stdout: JSON.stringify(
                  mutateBoard(
                    context,
                    cliBoard(input.options.chat, context, true, {
                      section: input.options.section,
                      project: input.options.project,
                    }),
                    (resolvedBoard) => service.archive(resolvedBoard, parsed.ids),
                  ),
                ),
              };
            });
          },
        }),
        image: cliCommand({
          summary: "Add a workspace image or video to the board",
          positionals: [{ name: "path", description: "Image or video path", required: true }],
          options: {
            ...json,
            chat: { type: "string", description: "Target chat ID; defaults to the invoking chat" },
            id: { type: "string", description: "Node id" },
            title: { type: "string", description: "Node title" },
            caption: { type: "string", description: "Caption below the image or video" },
            section: { type: "string", description: "Module group name" },
            "board-section": { type: "string", description: "Target project canvas section ID" },
            project: selectionOptions.project,
            narrow: { type: "boolean", description: "Use single width instead of wide" },
            after: { type: "string", description: "Place after this node id" },
          },
          async run(input, context) {
            return guarded(async () => {
              const threadId = cliBoard(input.options.chat, context, true, {
                section: input.options["board-section"],
                project: input.options.project,
              });

              const { path, ...node } = imageInputSchema.parse({
                path: input.positionals.path,
                id: input.options.id,
                title: input.options.title,
                body: input.options.caption,
                section: input.options.section,
                wide: input.options.narrow === true ? false : undefined,
                after: input.options.after,
              });

              const workspaceChat =
                input.options.chat ??
                context.threadId ??
                projects.getSection(threadId)?.originThreadId;

              if (!workspaceChat)
                throw new CanvasError(
                  "Supply --chat to select the media workspace for this section",
                );
              const bytes = await readMedia(api, workspaceChat, path, context.signal);

              return {
                exitCode: 0,
                stdout: JSON.stringify(
                  await (async () => {
                    const result = mutateBoard(context, threadId, (resolvedBoard) =>
                      service.addMedia(resolvedBoard, bytes, node),
                    );

                    const assetId = service
                      .board(threadId)
                      ?.nodes.find((entry) => entry.id === result.id)?.assetId;

                    if (assetId && media.isImage(assetId)) await media.prepare(assetId);

                    return result;
                  })(),
                ),
              };
            });
          },
        }),
      },
    }),
  );
}
