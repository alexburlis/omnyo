import {
  type PluginApi,
  type PluginAgentToolContext,
  type PluginCliContext,
} from "@omnyo/plugin-sdk";
import { z } from "zod";
import {
  bindingSchema,
  workspaceBindingSchema,
  type WorkspaceBinding,
  hostContract,
  idSchema,
  requirementSchema,
  requirementsSchema,
  workspaceInspectionSchema,
  type ContextBinding,
  type JsonPayload,
  type OwnershipStore,
  type Requirement,
  type RuntimeMethod,
  type WorkspaceInspection,
} from "./contracts.js";

const threadSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  environmentId: idSchema.nullable(),
});

const environmentSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  hostId: idSchema,
  path: z.string().nullable(),
  isGitRepo: z.boolean(),
});

const projectSchema = z.object({ id: idSchema });

const hostSchema = z.object({ id: idSchema, status: z.enum(["connected", "disconnected"]) });

export interface ContextReader {
  thread(id: string, signal: AbortSignal): Promise<z.infer<typeof threadSchema>>;
  environment(id: string, signal: AbortSignal): Promise<z.infer<typeof environmentSchema>>;
  project(id: string, signal: AbortSignal): Promise<z.infer<typeof projectSchema>>;
  host(id: string, signal: AbortSignal): Promise<z.infer<typeof hostSchema>>;
}

export interface Selectors {
  threadId?: string;
  projectId?: string;
  environmentId?: string;
  hostId?: string;
  canonicalRoot?: string;
}

export type Caller =
  | { kind: "native_tool"; context: Pick<PluginAgentToolContext, "threadId" | "projectId"> }
  | {
      kind: "owner";
      surface: "cli" | "ui";
      inherited?: Pick<PluginCliContext, "threadId" | "projectId" | "cwd">;
    };

export interface RoutingTransport {
  retainedRead?(
    input: {
      binding: ContextBinding;
      candidatePath: string;
      method: "result" | "artifact";
      payload: JsonPayload;
    },
    options: { hostId: string; signal: AbortSignal },
  ): Promise<{ missing: boolean; result?: JsonPayload }>;
  inspectWorkspace(
    candidate: {
      candidatePath: string;
      environmentId: string;
      projectId: string;
      gitCheckout: boolean;
    },
    options: { hostId: string; signal: AbortSignal },
  ): Promise<WorkspaceInspection>;
  invokeControl(
    method: "doctor" | "setup" | "status",
    input: { workspace: WorkspaceBinding; payload: JsonPayload },
    options: { hostId: string; signal: AbortSignal },
  ): Promise<JsonPayload>;
  invoke(
    method: RuntimeMethod,
    input: { binding: ContextBinding; payload: JsonPayload },
    options: { hostId: string; signal: AbortSignal },
  ): Promise<JsonPayload>;
}

export class RoutingError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "RoutingError";
  }
}

export function sdkContextReader(sdk: PluginApi["sdk"]): ContextReader {
  return {
    thread: async (threadId, signal) =>
      threadSchema.parse(await sdk.threads.get({ threadId, signal })),
    environment: async (environmentId, signal) =>
      environmentSchema.parse(await sdk.environments.get({ environmentId, signal })),
    project: async (projectId, signal) =>
      projectSchema.parse(await sdk.projects.get({ projectId, signal })),
    host: async (hostId, signal) => hostSchema.parse(await sdk.hosts.get({ hostId, signal })),
  };
}

export function sdkRoutingTransport(api: PluginApi): RoutingTransport {
  const client = api.hosts.experimental_client({ contract: hostContract });

  return {
    retainedRead: (input, options) =>
      client.call("retainedRead", input, { ...options, timeoutMs: 13000 }),
    inspectWorkspace: (input, options) =>
      client.call("inspectWorkspace", input, { ...options, timeoutMs: 10000 }),
    invokeControl: (method, input, options) =>
      client.call(method, input, { ...options, timeoutMs: 14000 }),
    invoke: (method, input, options) =>
      client.call(method, input, { ...options, timeoutMs: 13000 }),
  };
}

export function parseRequirementsJSON(value: string): Requirement[] {
  if (!value || /[\r\n]/.test(value) || Buffer.byteLength(value, "utf8") > 16384)
    throw new RoutingError("REQUIREMENTS_JSON_LINE_INVALID");

  try {
    return requirementsSchema.parse(JSON.parse(value));
  } catch {
    throw new RoutingError("REQUIREMENTS_INVALID");
  }
}

export { bindingFingerprint } from "./binding.js";

export function selectCallerContext(caller: Caller, selectors: Selectors) {
  if (caller.kind === "native_tool")
    return { threadId: caller.context.threadId, projectId: caller.context.projectId };
  const inherited = caller.inherited;

  if (
    (selectors.threadId && inherited?.threadId && selectors.threadId !== inherited.threadId) ||
    (selectors.projectId && inherited?.projectId && selectors.projectId !== inherited.projectId)
  )
    throw new RoutingError("CLI_CONTEXT_CONFLICT");
  const threadId = selectors.threadId ?? inherited?.threadId;

  if (!threadId) throw new RoutingError("THREAD_REQUIRED");

  return { ...selectors, threadId, projectId: selectors.projectId ?? inherited?.projectId };
}

function assertOwnership(binding: ContextBinding, current: ContextBinding, native: boolean): void {
  if (binding.threadId !== current.threadId)
    throw new RoutingError(native ? "FOREIGN_THREAD_RUN" : "RUN_CONTEXT_MISMATCH");

  if (binding.projectId !== current.projectId) throw new RoutingError("PROJECT_CONTEXT_CHANGED");

  if (binding.environmentId !== current.environmentId)
    throw new RoutingError("ENVIRONMENT_CONTEXT_CHANGED");

  if (binding.hostId !== current.hostId) throw new RoutingError("HOST_CONTEXT_CHANGED");

  if (binding.canonicalRoot !== current.canonicalRoot)
    throw new RoutingError(
      binding.workspaceId === current.workspaceId
        ? "WORKTREE_CONTEXT_CHANGED"
        : "WORKSPACE_CONTEXT_CHANGED",
    );

  if (binding.workspaceId !== current.workspaceId)
    throw new RoutingError("WORKSPACE_IDENTITY_CHANGED");

  if (binding.platform !== current.platform || binding.arch !== current.arch)
    throw new RoutingError("PLATFORM_CONTEXT_CHANGED");

  if (binding.policyHash !== current.policyHash) throw new RoutingError("POLICY_CONTEXT_CHANGED");
}

export function createRouting(context: {
  reader: ContextReader;
  transport: RoutingTransport;
  ownership: OwnershipStore;
  supportedTargets: ReadonlySet<string>;
  beforeSubmit?(binding: ContextBinding, payload: JsonPayload, signal: AbortSignal): Promise<void>;
  afterSubmit?(binding: ContextBinding, payload: JsonPayload, result: JsonPayload): Promise<void>;
}) {
  const resolve = async (
    caller: Caller,
    selectors: Selectors,
    signal: AbortSignal,
  ): Promise<ContextBinding> => {
    signal.throwIfAborted();
    const selection = selectCallerContext(caller, selectors);
    const thread = threadSchema.parse(await context.reader.thread(selection.threadId, signal));

    if (thread.id !== selection.threadId) throw new RoutingError("THREAD_CONTEXT_MISMATCH");

    if (selection.projectId && thread.projectId !== selection.projectId)
      throw new RoutingError("PROJECT_CONTEXT_MISMATCH");

    if (!thread.environmentId) throw new RoutingError("ENVIRONMENT_REQUIRED");

    const workspace = await resolveWorkspace(
      thread.projectId,
      thread.environmentId,
      selection,
      signal,
    );

    return bindingSchema.parse({ ...workspace, threadId: thread.id });
  };

  const resolveWorkspace = async (
    projectId: string,
    environmentId: string,
    selection: Selectors,
    signal: AbortSignal,
  ): Promise<WorkspaceBinding> => {
    const project = projectSchema.parse(await context.reader.project(projectId, signal));

    if (project.id !== projectId) throw new RoutingError("PROJECT_CONTEXT_MISMATCH");

    const environment = environmentSchema.parse(
      await context.reader.environment(environmentId, signal),
    );

    if (
      environment.id !== environmentId ||
      (selection.environmentId && environment.id !== selection.environmentId)
    )
      throw new RoutingError("ENVIRONMENT_CONTEXT_MISMATCH");

    if (environment.projectId !== projectId) throw new RoutingError("PROJECT_CONTEXT_MISMATCH");

    if (!environment.path) throw new RoutingError("WORKSPACE_REQUIRED");

    if (selection.hostId && selection.hostId !== environment.hostId)
      throw new RoutingError("HOST_CONTEXT_MISMATCH");
    const host = hostSchema.parse(await context.reader.host(environment.hostId, signal));

    if (host.id !== environment.hostId) throw new RoutingError("HOST_CONTEXT_MISMATCH");

    if (host.status !== "connected") throw new RoutingError("HOST_OFFLINE");

    const inspected = workspaceInspectionSchema.parse(
      await context.transport.inspectWorkspace(
        {
          candidatePath: environment.path,
          environmentId: environment.id,
          projectId: project.id,
          gitCheckout: environment.isGitRepo,
        },
        { hostId: environment.hostId, signal },
      ),
    );

    if (!inspected.directory) throw new RoutingError("WORKSPACE_REQUIRED");

    if (!inspected.withinWorkspace || inspected.candidateCanonicalPath !== inspected.canonicalRoot)
      throw new RoutingError("WORKSPACE_ESCAPE");

    if (selection.canonicalRoot && selection.canonicalRoot !== inspected.canonicalRoot)
      throw new RoutingError("WORKSPACE_CONTEXT_MISMATCH");

    if (!context.supportedTargets.has(`${inspected.platform}:${inspected.arch}`))
      throw new RoutingError("UNSUPPORTED_PLATFORM");
    signal.throwIfAborted();

    return workspaceBindingSchema.parse({
      projectId: project.id,
      environmentId: environment.id,
      hostId: environment.hostId,
      canonicalRoot: inspected.canonicalRoot,
      workspaceId: inspected.workspaceId,
      policyHash: inspected.policyHash,
      platform: inspected.platform,
      arch: inspected.arch,
    });
  };

  const dispatch = async (call: {
    caller: Caller;
    selectors: Selectors;
    method: RuntimeMethod;
    payload: JsonPayload;
    signal: AbortSignal;
  }): Promise<JsonPayload> => {
    if (call.method === "setup" && call.caller.kind !== "owner")
      throw new RoutingError("OWNER_SETUP_REQUIRED");

    if (
      call.caller.kind === "owner" &&
      !call.selectors.threadId &&
      !call.caller.inherited?.threadId &&
      ["doctor", "setup", "status"].includes(call.method)
    ) {
      const projectId = call.selectors.projectId ?? call.caller.inherited?.projectId;
      const environmentId = call.selectors.environmentId;

      if (!projectId || !environmentId) throw new RoutingError("PROJECT_ENVIRONMENT_REQUIRED");

      if (
        call.selectors.projectId &&
        call.caller.inherited?.projectId &&
        call.selectors.projectId !== call.caller.inherited.projectId
      )
        throw new RoutingError("CLI_CONTEXT_CONFLICT");

      const workspace = await resolveWorkspace(
        projectId,
        environmentId,
        call.selectors,
        call.signal,
      );

      call.signal.throwIfAborted();

      return context.transport.invokeControl(
        z.enum(["doctor", "setup", "status"]).parse(call.method),
        { workspace, payload: call.payload },
        { hostId: workspace.hostId, signal: call.signal },
      );
    }

    if (
      (call.method === "result" || call.method === "artifact") &&
      context.transport.retainedRead
    ) {
      const { runId } = z.object({ runId: idSchema }).parse(call.payload);
      const record = await context.ownership.getRun(runId);

      if (!record) throw new RoutingError("RUN_NOT_FOUND");
      const selection = selectCallerContext(call.caller, call.selectors);

      const thread = threadSchema.parse(
        await context.reader.thread(selection.threadId, call.signal),
      );

      if (thread.id !== selection.threadId || thread.id !== record.binding.threadId)
        throw new RoutingError(
          call.caller.kind === "native_tool" ? "FOREIGN_THREAD_RUN" : "RUN_CONTEXT_MISMATCH",
        );

      if (
        thread.projectId !== record.binding.projectId ||
        (selection.projectId && selection.projectId !== thread.projectId)
      )
        throw new RoutingError("PROJECT_CONTEXT_CHANGED");

      if (
        thread.environmentId !== record.binding.environmentId ||
        (selection.environmentId && selection.environmentId !== thread.environmentId)
      )
        throw new RoutingError("ENVIRONMENT_CONTEXT_CHANGED");

      const project = projectSchema.parse(
        await context.reader.project(thread.projectId, call.signal),
      );

      if (project.id !== thread.projectId) throw new RoutingError("PROJECT_CONTEXT_CHANGED");

      const environment = environmentSchema.parse(
        await context.reader.environment(record.binding.environmentId, call.signal),
      );

      if (
        environment.id !== record.binding.environmentId ||
        environment.projectId !== thread.projectId
      )
        throw new RoutingError("ENVIRONMENT_CONTEXT_CHANGED");

      if (
        environment.hostId !== record.binding.hostId ||
        (selection.hostId && selection.hostId !== environment.hostId)
      )
        throw new RoutingError("HOST_CONTEXT_CHANGED");
      const host = hostSchema.parse(await context.reader.host(environment.hostId, call.signal));

      if (host.id !== environment.hostId) throw new RoutingError("HOST_CONTEXT_CHANGED");

      if (host.status !== "connected") throw new RoutingError("HOST_OFFLINE");

      if (!environment.path) throw new RoutingError("WORKSPACE_REQUIRED");

      if (selection.canonicalRoot && selection.canonicalRoot !== record.binding.canonicalRoot)
        throw new RoutingError("WORKSPACE_CONTEXT_MISMATCH");

      const retained = await context.transport.retainedRead(
        {
          binding: record.binding,
          candidatePath: environment.path,
          method: call.method,
          payload: call.payload,
        },
        { hostId: environment.hostId, signal: call.signal },
      );

      if (retained.missing) {
        if (retained.result === undefined) throw new RoutingError("ARCHIVE_RESULT_UNAVAILABLE");

        return retained.result;
      }
    }

    const binding = await resolve(call.caller, call.selectors, call.signal);
    const native = call.caller.kind === "native_tool";

    const checkRun = async (runId: string) => {
      const record = await context.ownership.getRun(runId);

      if (!record) throw new RoutingError("RUN_NOT_FOUND");
      assertOwnership(bindingSchema.parse(record.binding), binding, native);

      return record;
    };

    if (["result", "events", "artifact", "cancel"].includes(call.method))
      await checkRun(z.object({ runId: idSchema }).parse(call.payload).runId);

    if (call.method === "submit") {
      const parsed = z
        .object({
          requestId: idSchema,
          submission: z
            .object({
              kind: z.enum(["run", "verify"]),
              request: z
                .object({
                  sessionId: idSchema.optional(),
                  previousRunId: idSchema.optional(),
                  requirements: z.array(requirementSchema).optional(),
                })
                .passthrough(),
            })
            .passthrough(),
        })
        .passthrough()
        .parse(call.payload);

      if (parsed.submission.kind === "verify")
        requirementsSchema.parse(parsed.submission.request.requirements);
      const request = parsed.submission.request;

      if (request.previousRunId) {
        const previous = await checkRun(request.previousRunId);

        if (request.sessionId !== previous.sessionId)
          throw new RoutingError("SESSION_REQUIRED_FOR_REUSE");
      }

      if (request.sessionId) {
        const previous = await context.ownership.getSession(request.sessionId);

        if (!previous) throw new RoutingError("SESSION_NOT_FOUND");
        assertOwnership(bindingSchema.parse(previous.binding), binding, native);
      }
    }

    if (call.method === "submit") await context.beforeSubmit?.(binding, call.payload, call.signal);
    call.signal.throwIfAborted();

    const result = await context.transport.invoke(
      call.method,
      { binding, payload: call.payload },
      { hostId: binding.hostId, signal: call.signal },
    );

    if (call.method === "submit") {
      const accepted = z.object({ runId: idSchema, sessionId: idSchema }).parse(result);
      const priorRun = await context.ownership.getRun(accepted.runId);
      const priorSession = await context.ownership.getSession(accepted.sessionId);

      if (priorRun) assertOwnership(priorRun.binding, binding, native);

      if (priorSession) assertOwnership(priorSession.binding, binding, native);
      await context.ownership.rememberSession({ sessionId: accepted.sessionId, binding });
      await context.ownership.rememberRun({
        runId: accepted.runId,
        sessionId: accepted.sessionId,
        binding,
      });
      await context.afterSubmit?.(binding, call.payload, result);
    }

    return result;
  };

  return { resolve, dispatch };
}
