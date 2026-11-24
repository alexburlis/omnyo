import {
  createThread,
  getEnvironment,
  getThread,
  listEvents,
  setAiServiceSelection,
  updateThread,
} from "@omnyo/db";
import {
  type JsonValue,
  type ResolvedThreadExecutionOptions,
  systemThreadProvisioningEventDataSchema,
  threadSchema,
  turnScope,
} from "@omnyo/domain";
import { groupHostDaemonEvents } from "@omnyo/host-daemon-contract";
import type { ProviderEnvironmentArgs } from "@omnyo/server-contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  internalAuthHeaders,
  listQueuedThreadCommands,
  reportQueuedCommandError,
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
  waitForQueuedCommandAfter,
} from "../helpers/commands.js";
import { readJson } from "../helpers/json.js";
import { skillInput, textInput } from "../helpers/prompt-input.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadIdentity,
  seedTurnStarted,
} from "../helpers/seed.js";
import {
  withTestHarness as withBaseHarness,
  type TestAppHarness,
} from "../helpers/test-app.js";
import { registerFakeAiService } from "../helpers/ai-services.js";
import {
  checkoutProviderInputsSchema,
  installFakeEnvironmentProvider,
  installFakeGitWorktreeProvider,
  worktreeProviderInputsSchema,
} from "../helpers/environment-provider.js";
import { runEnvironmentProvisioningSweep } from "../../src/services/system/periodic-sweeps.js";
import { createThreadFromRequest } from "../../src/services/threads/thread-create.js";
import { dispatchThreadRenameCommand } from "../../src/services/threads/thread-commands.js";
import { requestThreadStopForCurrentState } from "../../src/services/threads/thread-lifecycle.js";
import {
  advanceThreadProvisioning,
  requestThreadProvision,
} from "../../src/services/threads/thread-provisioning.js";
import { generateThreadMetadataWithOutcome } from "../../src/services/threads/title-generation.js";

interface MockThreadMetadata {
  title?: string;
}

const completeTitle = vi.fn<(prompt: string) => Promise<string>>();

function registerTitleService(harness: TestAppHarness): TestAppHarness {
  registerFakeAiService(harness.deps.aiServices, {
    id: "codex",
    pluginId: "provider-codex",
    builtin: true,
    complete: (prompt) => completeTitle(prompt),
  });

  return harness;
}

function withTestHarness<T>(
  run: (harness: TestAppHarness) => Promise<T>,
): Promise<T> {
  return withBaseHarness({}, (harness) => run(registerTitleService(harness)));
}

function sentPrompt(index = 0): string {
  return completeTitle.mock.calls[index]?.[0] ?? "";
}

function mockThreadMetadata(metadata: MockThreadMetadata): void {
  completeTitle.mockResolvedValue(metadata.title ?? "");
}

function deferredTitle(): {
  promise: Promise<string>;
  resolve: (metadata: MockThreadMetadata) => void;
} {
  let resolve: (metadata: MockThreadMetadata) => void = () => {
    throw new Error("Title generation was not started");
  };

  const promise = new Promise<string>((settle) => {
    resolve = (metadata) => settle(metadata.title ?? "");
  });

  return { promise, resolve };
}

function pendingThreadMetadata(): (metadata: MockThreadMetadata) => void {
  let current: ReturnType<typeof deferredTitle> | null = null;
  completeTitle.mockImplementation(() => {
    current = deferredTitle();

    return current.promise;
  });

  return (metadata) => {
    if (current === null) {
      throw new Error("Title generation was not started");
    }

    current.resolve(metadata);
  };
}

const THREAD_START_EXECUTION = {
  model: "gpt-5",
  serviceTier: "default",
  reasoningLevel: "medium",
  permissionMode: "accept-edits",
  source: "client/turn/requested",
} satisfies ResolvedThreadExecutionOptions;

interface CreateThreadWithEnvironmentArgs {
  hostId: string;
  projectId: string;
  text: string;
  title?: string;
  environment?: ProviderEnvironmentArgs;
}

async function createThreadWithEnvironment(
  harness: TestAppHarness,
  args: CreateThreadWithEnvironmentArgs,
) {
  const response = await harness.app.request("/api/v1/threads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      origin: "app",
      projectId: args.projectId,
      providerId: "codex",
      model: "gpt-5",
      ...(args.title === undefined ? {} : { title: args.title }),
      input: [{ type: "text", text: args.text }],
      environment: args.environment ?? {
        type: "host",
        hostId: args.hostId,
        workspace: {
          type: "managed-worktree",
          baseBranch: { kind: "default" },
        },
      },
    }),
  });

  expect(response.status).toBe(201);

  return threadSchema.parse(await readJson(response));
}

function provisioningEntries(harness: TestAppHarness, threadId: string) {
  return listEvents(harness.db, { threadId })
    .filter((event) => event.type === "system/thread-provisioning")
    .flatMap(
      (event) =>
        systemThreadProvisioningEventDataSchema.parse(JSON.parse(event.data))
          .entries,
    );
}

describe("generated thread titles", () => {
  beforeEach(() => {
    completeTitle.mockReset();
  });

  const checkoutCases: Array<{
    name: string;
    inputs: JsonValue;
    branchName: string;
    titleBeforeStartAcknowledgement: boolean;
    manualTitle: boolean;
  }> = [
    {
      name: "an unchanged branch",
      inputs: {},
      branchName: "main",
      titleBeforeStartAcknowledgement: false,
      manualTitle: false,
    },
    {
      name: "an existing branch",
      inputs: { branch: { kind: "existing", name: "release" } },
      branchName: "release",
      titleBeforeStartAcknowledgement: true,
      manualTitle: false,
    },
    {
      name: "a manual title change",
      inputs: {},
      branchName: "main",
      titleBeforeStartAcknowledgement: false,
      manualTitle: true,
    },
  ];

  it.each(checkoutCases)(
    "starts Project checkout with $name before title generation finishes",
    async ({
      inputs,
      branchName,
      titleBeforeStartAcknowledgement,
      manualTitle,
    }) => {
      const metadata = deferredTitle();
      completeTitle.mockReturnValue(metadata.promise);

      await withTestHarness(async (harness) => {
        const { host } = seedHostSession(harness.deps, {
          id: "host-checkout-pending-title",
        });

        const path = "/tmp/checkout-pending-title-project";

        const { project } = seedProjectWithSource(harness.deps, {
          hostId: host.id,
          path,
        });

        const thread = await createThreadWithEnvironment(harness, {
          hostId: host.id,
          projectId: project.id,
          text: "Start work before the automatic title is ready",
          environment: {
            type: "provider",
            environmentProviderId: "project-checkout",
            machine: { type: "existing", hostId: host.id },
            inputs,
          },
        });

        try {
          await vi.waitFor(() => {
            expect(completeTitle).toHaveBeenCalledTimes(1);
          });

          const attach = await waitForQueuedCommand(
            harness,
            ({ command }) =>
              command.type === "environment.attach" &&
              command.initiator?.threadId === thread.id,
          );

          await reportQueuedCommandSuccess(harness, attach, {
            path,
            isGitRepo: true,
            isWorktree: false,
            branchName,
            defaultBranch: "main",
            transcript: [],
          });

          const start = await waitForQueuedCommand(
            harness,
            ({ command }) =>
              command.type === "thread.start" && command.threadId === thread.id,
          );

          expect(getThread(harness.db, thread.id)?.title).toBeNull();
          expect(completeTitle).toHaveBeenCalledTimes(1);

          if (titleBeforeStartAcknowledgement) {
            metadata.resolve({ title: "Generated Checkout Title" });
            await vi.waitFor(() => {
              expect(getThread(harness.db, thread.id)?.title).toBe(
                "Generated Checkout Title",
              );
            });
          }

          await reportQueuedCommandSuccess(
            harness,
            start,
            { providerThreadId: "provider-checkout-pending-title" },
            { hostId: host.id },
          );
          expect(getThread(harness.db, thread.id)?.status).toBe("active");

          if (manualTitle) {
            const response = await harness.app.request(
              `/api/v1/threads/${thread.id}`,
              {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ title: "My Checkout Title" }),
              },
            );

            expect(response.status).toBe(200);
          }

          if (!titleBeforeStartAcknowledgement) {
            metadata.resolve({ title: "Generated Checkout Title" });
          }

          const rename = await waitForQueuedCommandAfter(
            harness,
            start.row.cursor,
            ({ command }) =>
              command.type === "thread.rename" &&
              command.threadId === thread.id,
          );

          const expectedTitle = manualTitle
            ? "My Checkout Title"
            : "Generated Checkout Title";

          expect(rename.command).toMatchObject({ title: expectedTitle });
          expect(getThread(harness.db, thread.id)?.title).toBe(expectedTitle);

          if (manualTitle) {
            await expect(
              waitForQueuedCommandAfter(
                harness,
                rename.row.cursor,
                ({ command }) =>
                  command.type === "thread.rename" &&
                  command.threadId === thread.id,
                100,
              ),
            ).rejects.toThrow("Timed out waiting for queued command");
          }

          const provisioning = listEvents(harness.db, { threadId: thread.id })
            .filter((event) => event.type === "system/thread-provisioning")
            .map((event) =>
              systemThreadProvisioningEventDataSchema.parse(
                JSON.parse(event.data),
              ),
            );

          expect(provisioning.at(-1)?.status).toBe("completed");
        } finally {
          metadata.resolve({ title: "Generated Checkout Title" });
          await vi.waitFor(() => {
            expect(getThread(harness.db, thread.id)?.title).not.toBeNull();
          });
        }
      });
    },
  );

  const titleApplicationRaceCases: Array<{
    name: string;
    environmentType: "provider" | "reuse";
    manualTitle: string | null;
  }> = [
    {
      name: "Project checkout with a replacement title",
      environmentType: "provider",
      manualTitle: "My Latest Title",
    },
    {
      name: "a ready reused environment with a replacement title",
      environmentType: "reuse",
      manualTitle: "My Latest Title",
    },
    {
      name: "Project checkout with a cleared title",
      environmentType: "provider",
      manualTitle: null,
    },
    {
      name: "a ready reused environment with a cleared title",
      environmentType: "reuse",
      manualTitle: null,
    },
  ];

  it.each(titleApplicationRaceCases)(
    "preserves a manual title changed after generated title application in $name",
    async ({ environmentType, manualTitle }) => {
      const metadata = deferredTitle();
      completeTitle.mockReturnValue(metadata.promise);

      await withTestHarness(async (harness) => {
        const { host } = seedHostSession(harness.deps, {
          id: "host-title-application-race",
        });

        const path = "/tmp/title-application-race-project";

        const { project } = seedProjectWithSource(harness.deps, {
          hostId: host.id,
          path,
        });

        const existingEnvironment =
          environmentType === "reuse"
            ? seedEnvironment(harness.deps, {
                hostId: host.id,
                projectId: project.id,
                path,
                status: "ready",
              })
            : null;

        const thread = await createThreadFromRequest(harness.deps, {
          environment: existingEnvironment
            ? { type: "reuse", environmentId: existingEnvironment.id }
            : {
                type: "provider",
                environmentProviderId: "project-checkout",
                machine: { type: "existing", hostId: host.id },
                inputs: {},
              },
          input: textInput(
            "Keep a newer manual title during automatic title sync",
          ),
          model: "gpt-5",
          origin: "app",
          projectId: project.id,
          providerId: "codex",
          startedOnBehalfOf: null,
        });

        try {
          await vi.waitFor(() => {
            expect(completeTitle).toHaveBeenCalledTimes(1);
          });

          if (environmentType === "provider") {
            const attach = await waitForQueuedCommand(
              harness,
              ({ command }) =>
                command.type === "environment.attach" &&
                command.initiator?.threadId === thread.id,
            );

            await reportQueuedCommandSuccess(harness, attach, {
              path,
              isGitRepo: true,
              isWorktree: false,
              branchName: "main",
              defaultBranch: "main",
              transcript: [],
            });
          }

          const start = await waitForQueuedCommand(
            harness,
            ({ command }) =>
              command.type === "thread.start" && command.threadId === thread.id,
          );

          await reportQueuedCommandSuccess(
            harness,
            start,
            { providerThreadId: "provider-title-application-race" },
            { hostId: host.id },
          );
          const activeThread = getThread(harness.db, thread.id);

          if (!activeThread?.environmentId) {
            throw new Error("Expected a started thread with an environment");
          }

          const environment = getEnvironment(
            harness.db,
            activeThread.environmentId,
          );

          if (!environment) {
            throw new Error("Expected the thread environment");
          }

          expect(activeThread.status).toBe("active");
          expect(activeThread.title).toBeNull();

          const generatedTitle = "Generated Before Manual Edit";
          let generatedTitleObserved = false;
          let manualEditCompleted = false;

          const unsubscribe = harness.hub.onChangedMessage((message) => {
            if (
              message.entity !== "thread" ||
              message.id !== thread.id ||
              !message.changes.includes("title-changed") ||
              generatedTitleObserved ||
              getThread(harness.db, thread.id)?.title !== generatedTitle
            ) {
              return;
            }

            generatedTitleObserved = true;
            queueMicrotask(() => {
              updateThread(harness.db, harness.hub, thread.id, {
                title: manualTitle,
              });

              if (manualTitle) {
                dispatchThreadRenameCommand(harness.deps, {
                  environment: {
                    id: environment.id,
                    hostId: environment.hostId,
                  },
                  providerId: activeThread.providerId,
                  threadId: thread.id,
                  title: manualTitle,
                });
              }

              manualEditCompleted = true;
            });
          });

          try {
            metadata.resolve({ title: generatedTitle });
            await vi.waitFor(() => {
              expect(manualEditCompleted).toBe(true);
            });
            expect(generatedTitleObserved).toBe(true);
            expect(getThread(harness.db, thread.id)?.title).toBe(manualTitle);
            await expect(
              waitForQueuedCommandAfter(
                harness,
                start.row.cursor,
                ({ command }) =>
                  command.type === "thread.rename" &&
                  command.threadId === thread.id &&
                  command.title === generatedTitle,
                100,
              ),
            ).rejects.toThrow("Timed out waiting for queued command");

            const renames = listQueuedThreadCommands(
              harness,
              "thread.rename",
              thread.id,
            );

            if (manualTitle === null) {
              expect(renames).toEqual([]);
            } else {
              expect(renames.at(-1)).toMatchObject({ title: manualTitle });
            }

            expect(completeTitle).toHaveBeenCalledTimes(1);
          } finally {
            unsubscribe();
          }
        } finally {
          metadata.resolve({ title: "Generated Before Manual Edit" });
        }
      });
    },
  );

  const titleDependentProviderCases: Array<{
    name: string;
    environmentProviderId: string;
    inputs: JsonValue;
  }> = [
    {
      name: "a new checkout branch",
      environmentProviderId: "project-checkout",
      inputs: { branch: { kind: "new", baseBranch: "main" } },
    },
    {
      name: "a new worktree",
      environmentProviderId: "git-worktree",
      inputs: { branch: { kind: "default" } },
    },
    {
      name: "a custom environment provider",
      environmentProviderId: "custom-checkout",
      inputs: {},
    },
  ];

  it.each(titleDependentProviderCases)(
    "waits for a title before provisioning $name",
    async ({ environmentProviderId, inputs }) => {
      const metadata = deferredTitle();
      completeTitle.mockReturnValue(metadata.promise);

      await withTestHarness(async (harness) => {
        const provider = installFakeEnvironmentProvider({
          id: environmentProviderId,
          pluginId: `environment-${environmentProviderId}`,
          displayName: "Title-dependent provider",
          requires: {
            projectCheckout: true,
            gitCheckout: false,
            gitRemote: false,
            projectless: false,
          },
          inputs:
            environmentProviderId === "git-worktree"
              ? worktreeProviderInputsSchema
              : checkoutProviderInputsSchema,
          decide: () => ({ action: "wait", reason: "Waiting for setup" }),
        });

        const { host } = seedHostSession(harness.deps, {
          id: "host-title-dependent-provider",
        });

        const { project } = seedProjectWithSource(harness.deps, {
          hostId: host.id,
          path: "/tmp/title-dependent-provider-project",
        });

        const thread = await createThreadWithEnvironment(harness, {
          hostId: host.id,
          projectId: project.id,
          text: "Use the generated title before provisioning the workspace",
          environment: {
            type: "provider",
            environmentProviderId,
            machine: { type: "existing", hostId: host.id },
            inputs,
          },
        });

        try {
          await vi.waitFor(() => {
            expect(completeTitle).toHaveBeenCalledTimes(1);
          });
          await expect(
            vi.waitFor(
              () => {
                expect(provider.contexts.length).toBeGreaterThan(0);
              },
              { timeout: 100, interval: 10 },
            ),
          ).rejects.toThrow();
          expect(provider.contexts).toHaveLength(0);
          expect(getThread(harness.db, thread.id)?.environmentId).toBeNull();

          metadata.resolve({ title: "Generated Dependency Title" });
          const context = await provider.waitForProvision();
          expect(context).toMatchObject({
            thread: { id: thread.id, title: "Generated Dependency Title" },
            suggestedBranchName: `omnyo/generated-dependency-title-${thread.id}`,
          });
          expect(completeTitle).toHaveBeenCalledTimes(1);
        } finally {
          metadata.resolve({ title: "Generated Dependency Title" });
          await vi.waitFor(() => {
            expect(getThread(harness.db, thread.id)?.title).toBe(
              "Generated Dependency Title",
            );
          });
        }
      });
    },
  );

  it("resolves a managed-worktree request to the worktree provider once the title is generated", async () => {
    mockThreadMetadata({ title: "Improve Branch Names" });
    await withTestHarness(async (harness) => {
      const provider = installFakeGitWorktreeProvider();

      const { host } = seedHostSession(harness.deps, {
        id: "host-generated-branch",
      });

      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/generated-branch-project",
      });

      const thread = await createThreadWithEnvironment(harness, {
        hostId: host.id,
        projectId: project.id,
        text: "Improve the generated branch naming path",
      });

      expect(thread.title).toBeNull();

      const context = await provider.waitForProvision();
      expect(context.thread.id).toBe(thread.id);
      expect(context.thread.title).toBe("Improve Branch Names");
      expect(context.host?.id).toBe(host.id);
      expect(context.inputs).toEqual({ branch: { kind: "default" } });
      expect(getThread(harness.db, thread.id)?.title).toBe(
        "Improve Branch Names",
      );
      expect(completeTitle).toHaveBeenCalledTimes(1);
    });
  });

  it("opens the workspace-setup block before metadata inference completes", async () => {
    const resolveMetadata = pendingThreadMetadata();

    await withTestHarness(async (harness) => {
      const provider = installFakeGitWorktreeProvider();

      const { host } = seedHostSession(harness.deps, {
        id: "host-managed-early-provisioning-row",
      });

      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/managed-early-provisioning-row-project",
      });

      const thread = await createThreadWithEnvironment(harness, {
        hostId: host.id,
        projectId: project.id,
        text: "Show provisioning before generated branch metadata finishes",
      });

      await vi.waitFor(() => {
        expect(completeTitle).toHaveBeenCalledTimes(1);
        expect(provisioningEntries(harness, thread.id)[0]?.key).toBe(
          "workspace-started",
        );
      });
      expect(getThread(harness.db, thread.id)?.environmentId).toBeNull();
      expect(provider.contexts).toHaveLength(0);

      resolveMetadata({ title: "Early Visible Provisioning" });

      const context = await provider.waitForProvision();
      expect(context.thread.title).toBe("Early Visible Provisioning");
    });
  });

  it("does not fail a stopped thread when metadata inference settles", async () => {
    const resolveMetadata = pendingThreadMetadata();

    await withTestHarness(async (harness) => {
      const provider = installFakeGitWorktreeProvider();

      const { host } = seedHostSession(harness.deps, {
        id: "host-stop-during-metadata",
      });

      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/stop-during-metadata-project",
      });

      const thread = seedThread(harness.deps, {
        projectId: project.id,
        status: "starting",
        title: null,
        titleFallback: "Stop during metadata inference",
      });

      const input = textInput("Stop during metadata inference before setup");
      requestThreadProvision(harness.deps, {
        author: { initiator: "user", senderThreadId: null },
        environmentIntent: {
          type: "provider",
          environmentProviderId: "git-worktree",
          machine: { type: "existing", hostId: host.id },
          inputs: { branch: { kind: "default" } },
          selectionResolved: true,
        },
        execution: THREAD_START_EXECUTION,
        fork: null,
        input,
        startedOnBehalfOf: null,
        thread,
        titleProvided: false,
      });

      const advance = advanceThreadProvisioning(harness.deps, {
        threadId: thread.id,
      });

      await vi.waitFor(() => {
        expect(completeTitle).toHaveBeenCalledTimes(1);
      });

      const startingThread = getThread(harness.db, thread.id);

      if (!startingThread) {
        throw new Error("Expected the starting thread");
      }

      expect(startingThread.environmentId).toBeNull();
      requestThreadStopForCurrentState(harness.deps, startingThread, null);
      expect(getThread(harness.db, thread.id)).toMatchObject({
        status: "idle",
      });

      resolveMetadata({ title: "Stopped Metadata Race" });
      await advance;

      expect(getThread(harness.db, thread.id)).toMatchObject({
        status: "idle",
      });
      const events = listEvents(harness.db, { threadId: thread.id });
      expect(events.map((event) => event.type)).not.toContain("system/error");
      expect(provider.contexts).toHaveLength(0);
      expect(getThread(harness.db, thread.id)?.environmentId).toBeNull();
    });
  });

  it("does not fail a thread waiting on metadata during provisioning sweeps", async () => {
    const resolveMetadata = pendingThreadMetadata();

    await withTestHarness(async (harness) => {
      const provider = installFakeGitWorktreeProvider();

      const { host } = seedHostSession(harness.deps, {
        id: "host-managed-prepared-sweep",
      });

      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/managed-prepared-sweep-project",
      });

      const thread = await createThreadWithEnvironment(harness, {
        hostId: host.id,
        projectId: project.id,
        text: "Keep prepared provisioning safe during sweeps",
      });

      await vi.waitFor(() => {
        expect(completeTitle).toHaveBeenCalledTimes(1);
        expect(provisioningEntries(harness, thread.id)).not.toHaveLength(0);
      });

      await runEnvironmentProvisioningSweep(harness.deps);

      expect(getThread(harness.db, thread.id)?.status).toBe("starting");
      expect(
        listEvents(harness.db, { threadId: thread.id }).map(
          (event) => event.type,
        ),
      ).not.toContain("system/error");

      resolveMetadata({ title: "Prepared Sweep Safe" });

      const context = await provider.waitForProvision();
      expect(context.thread.title).toBe("Prepared Sweep Safe");
    });
  });

  it("falls through to the next Automatic service for provider-path titles", async () => {
    completeTitle.mockResolvedValueOnce("Recovered Managed Metadata");
    await withTestHarness(async (harness) => {
      const failing = registerFakeAiService(harness.deps.aiServices, {
        id: "helper",
        pluginId: "helper-plugin",
        complete: async () => {
          throw new Error("Helper is overloaded");
        },
      });

      const provider = installFakeGitWorktreeProvider();

      const { host } = seedHostSession(harness.deps, {
        id: "host-managed-metadata-retry",
      });

      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/managed-metadata-retry-project",
      });

      const thread = await createThreadWithEnvironment(harness, {
        hostId: host.id,
        projectId: project.id,
        text: "Recover managed metadata after a failed first service",
      });

      const context = await provider.waitForProvision();
      expect(context.thread.title).toBe("Recovered Managed Metadata");
      expect(getThread(harness.db, thread.id)?.title).toBe(
        "Recovered Managed Metadata",
      );
      expect(completeTitle).toHaveBeenCalledTimes(1);
      expect(failing.completeCalls).toHaveLength(1);
    });
  });

  it("queues a daemon rename after a generated title thread starts", async () => {
    mockThreadMetadata({ title: "Generated Rename Title" });
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-generated-title-rename",
      });

      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/generated-title-rename-project",
      });

      seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/generated-title-rename-workspace",
        status: "ready",
      });
      installFakeGitWorktreeProvider(() => ({
        action: "ready",
        environment: {
          type: "host",
          hostId: host.id,
          path: "/tmp/generated-title-rename-workspace",
        },
      }));

      const thread = await createThreadWithEnvironment(harness, {
        hostId: host.id,
        projectId: project.id,
        text: "Generate a title then sync it after startup",
      });

      const start = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.start" && command.threadId === thread.id,
      );

      await reportQueuedCommandSuccess(
        harness,
        start,
        { providerThreadId: "provider-generated-title-rename" },
        { hostId: host.id },
      );

      const rename = await waitForQueuedCommandAfter(
        harness,
        start.row.cursor,
        ({ command }) =>
          command.type === "thread.rename" && command.threadId === thread.id,
      );

      expect(rename.command).toMatchObject({
        type: "thread.rename",
        threadId: thread.id,
        title: "Generated Rename Title",
      });
    });
  });

  it("generates titles for submitted fork threads", async () => {
    mockThreadMetadata({ title: "Generated Fork Title" });

    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-generated-fork-title",
      });

      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/generated-fork-title-project",
      });

      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/generated-fork-title-project",
        status: "ready",
      });

      const sourceThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });

      seedThreadIdentity(harness.deps, {
        threadId: sourceThread.id,
        providerThreadId: "provider-generated-fork-title-source",
      });
      seedTurnStarted(harness.deps, {
        threadId: sourceThread.id,
        turnId: "turn-generated-fork-title-source",
        providerThreadId: "provider-generated-fork-title-source",
      });

      const input = textInput("Continue this fork and generate a useful title");

      const fork = await createThreadFromRequest(harness.deps, {
        environment: { type: "reuse", environmentId: environment.id },
        input,
        model: "gpt-5",
        origin: "app",
        originKind: "fork",
        projectId: project.id,
        providerId: "codex",
        sourceThreadId: sourceThread.id,
        startedOnBehalfOf: null,
      });

      expect(getThread(harness.db, fork.id)?.titleFallback).toBe(
        "Continue this fork and generate a useful title",
      );

      const start = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.start" && command.threadId === fork.id,
      );

      if (start.command.type !== "thread.start") {
        throw new Error("Expected a thread.start command");
      }

      expect(start.command.input).toEqual(input);
      expect(start.command.fork).toEqual({
        sourceProviderThreadId: "provider-generated-fork-title-source",
        restoreArchivedSource: true,
      });

      await reportQueuedCommandSuccess(
        harness,
        start,
        { providerThreadId: "provider-generated-fork-title" },
        { hostId: host.id },
      );

      await vi.waitFor(() => {
        expect(getThread(harness.db, fork.id)?.title).toBe(
          "Generated Fork Title",
        );
      });
    });
  });
  it("does not queue a daemon rename for user-supplied titles", async () => {
    mockThreadMetadata({ title: "Generated Title" });
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-user-title-no-rename",
      });

      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/user-title-no-rename-project",
      });

      seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/user-title-no-rename-workspace",
        status: "ready",
      });
      installFakeGitWorktreeProvider(() => ({
        action: "ready",
        environment: {
          type: "host",
          hostId: host.id,
          path: "/tmp/user-title-no-rename-workspace",
        },
      }));

      const thread = await createThreadWithEnvironment(harness, {
        hostId: host.id,
        projectId: project.id,
        text: "Use the user supplied title without daemon rename",
        title: "User Picked Title",
      });

      const start = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.start" && command.threadId === thread.id,
      );

      await reportQueuedCommandSuccess(
        harness,
        start,
        { providerThreadId: "provider-user-title-no-rename" },
        { hostId: host.id },
      );

      await expect(
        waitForQueuedCommandAfter(
          harness,
          start.row.cursor,
          ({ command }) =>
            command.type === "thread.rename" && command.threadId === thread.id,
          100,
        ),
      ).rejects.toThrow("Timed out waiting for queued command");
      expect(completeTitle).not.toHaveBeenCalled();
    });
  });

  it("renames an idle non-managed thread when its title lands late", async () => {
    const resolveMetadata = pendingThreadMetadata();

    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-idle-late-title-rename",
      });

      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/idle-late-title-rename-project",
      });

      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/idle-late-title-rename-workspace",
        status: "ready",
      });

      const thread = createThread(harness.db, harness.hub, {
        projectId: project.id,
        environmentId: environment.id,
        providerId: "codex",
        status: "starting",
        title: null,
        titleFallback: "Idle late title rename",
      });

      requestThreadProvision(harness.deps, {
        author: { initiator: "user", senderThreadId: null },
        environmentIntent: {
          type: "reuse",
          environmentId: environment.id,
        },
        execution: THREAD_START_EXECUTION,
        fork: null,
        input: textInput("Generate a title for this non-managed reuse thread"),
        startedOnBehalfOf: null,
        thread,
        titleProvided: false,
      });
      await advanceThreadProvisioning(harness.deps, {
        threadId: thread.id,
      });

      const start = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.start" && command.threadId === thread.id,
      );

      await reportQueuedCommandSuccess(
        harness,
        start,
        { providerThreadId: "provider-idle-late-title" },
        { hostId: host.id },
      );
      expect(getThread(harness.db, thread.id)?.status).toBe("active");
      expect(getThread(harness.db, thread.id)?.title).toBeNull();

      const eventsResponse = await harness.app.request(
        "/internal/session/events",
        {
          method: "POST",
          headers: internalAuthHeaders(harness),
          body: JSON.stringify({
            sessionId: session.id,
            eventGroups: groupHostDaemonEvents([
              {
                threadId: thread.id,
                event: {
                  type: "turn/started",
                  threadId: thread.id,
                  providerThreadId: "provider-idle-late-title",
                  scope: turnScope("turn-idle-late-title"),
                },
              },
              {
                threadId: thread.id,
                event: {
                  type: "turn/completed",
                  threadId: thread.id,
                  providerThreadId: "provider-idle-late-title",
                  scope: turnScope("turn-idle-late-title"),
                  status: "completed",
                },
              },
            ]),
          }),
        },
      );

      expect(eventsResponse.status).toBe(200);
      expect(getThread(harness.db, thread.id)?.status).toBe("idle");

      await vi.waitFor(() => {
        expect(completeTitle).toHaveBeenCalledTimes(1);
      });

      resolveMetadata({ title: "Late Idle Title" });

      const rename = await waitForQueuedCommandAfter(
        harness,
        start.row.cursor,
        ({ command }) =>
          command.type === "thread.rename" && command.threadId === thread.id,
      );

      expect(rename.command).toMatchObject({
        type: "thread.rename",
        threadId: thread.id,
        title: "Late Idle Title",
      });
      expect(getThread(harness.db, thread.id)?.title).toBe("Late Idle Title");
    });
  });

  it("does not rename a non-managed thread that errored before its title landed", async () => {
    const resolveMetadata = pendingThreadMetadata();

    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-errored-late-title-no-rename",
      });

      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/errored-late-title-no-rename-project",
      });

      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/errored-late-title-no-rename-workspace",
        status: "ready",
      });

      const thread = createThread(harness.db, harness.hub, {
        projectId: project.id,
        environmentId: environment.id,
        providerId: "codex",
        status: "starting",
        title: null,
        titleFallback: "Errored late title no rename",
      });

      requestThreadProvision(harness.deps, {
        author: { initiator: "user", senderThreadId: null },
        environmentIntent: {
          type: "reuse",
          environmentId: environment.id,
        },
        execution: THREAD_START_EXECUTION,
        fork: null,
        input: textInput("Generate a title for this non-managed reuse thread"),
        startedOnBehalfOf: null,
        thread,
        titleProvided: false,
      });
      await advanceThreadProvisioning(harness.deps, {
        threadId: thread.id,
      });

      const start = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.start" && command.threadId === thread.id,
      );

      await reportQueuedCommandError(
        harness,
        start,
        {
          errorCode: "thread_start_failed",
          errorMessage: "Thread start failed",
        },
        { hostId: host.id },
      );
      expect(getThread(harness.db, thread.id)?.status).toBe("error");

      resolveMetadata({ title: "Errored Late Title" });

      await expect(
        waitForQueuedCommandAfter(
          harness,
          start.row.cursor,
          ({ command }) =>
            command.type === "thread.rename" && command.threadId === thread.id,
          100,
        ),
      ).rejects.toThrow("Timed out waiting for queued command");
      expect(
        listQueuedThreadCommands(harness, "thread.rename", thread.id),
      ).toEqual([]);
    });
  });
  it("skips generation when thread titles are turned off", async () => {
    await withTestHarness(async (harness) => {
      setAiServiceSelection(harness.db, "thread-title", { mode: "off" });
      await expect(
        generateThreadMetadataWithOutcome(harness.deps, {
          input: textInput("Improve the generated title fallback path"),
          threadId: "thr_inference_unavailable",
        }),
      ).resolves.toMatchObject({
        metadata: null,
        reason: "inference-unavailable",
      });
      expect(completeTitle).not.toHaveBeenCalled();
    });
  });

  it("reports no service when nothing can generate titles", async () => {
    await withBaseHarness({}, async (harness) => {
      await expect(
        generateThreadMetadataWithOutcome(harness.deps, {
          input: textInput("Improve the generated title fallback path"),
          threadId: "thr_no_service",
        }),
      ).resolves.toMatchObject({
        metadata: null,
        reason: "inference-unavailable",
      });
    });
  });

  it("cleans and clamps a chatty title reply", async () => {
    completeTitle.mockResolvedValue(
      '<think>short and clear</think>\nTitle: "Make the generated branch names easier to read in the sidebar"',
    );
    await withTestHarness(async (harness) => {
      const outcome = await generateThreadMetadataWithOutcome(harness.deps, {
        input: textInput("Make generated branch names easier to read"),
        threadId: "thr_chatty_title",
      });

      expect(outcome.metadata?.title).toBe(
        "Make the generated branch names easier to read",
      );
    });
  });

  it("titles a skill invocation from the task, not the command token", async () => {
    mockThreadMetadata({ title: "Drop stale release branches" });
    await withTestHarness(async (harness) => {
      await expect(
        generateThreadMetadataWithOutcome(harness.deps, {
          input: skillInput(
            "sync-repo",
            " and drop the stale release branches",
          ),
          threadId: "thr_skill_metadata",
        }),
      ).resolves.toMatchObject({
        metadata: { title: "Drop stale release branches" },
      });
      const prompt = sentPrompt();
      expect(prompt).toContain("and drop the stale release branches");
      expect(prompt).toContain(
        "The prompt invokes these commands or skills: /sync-repo.",
      );
      expect(prompt).not.toContain("/sync-repo and drop");
    });
  });

  it("sends task details beyond the fallback title limit to the title service", async () => {
    mockThreadMetadata({ title: "Show plan completion burndown" });
    await withTestHarness(async (harness) => {
      const task =
        'For the plan graph tooling, can we show in the background of the plan graph visualizer the "burndown" chart? Show how many plan items have been completed over time, from the beginning of the ledger to now.';

      await generateThreadMetadataWithOutcome(harness.deps, {
        input: textInput(task),
        threadId: "thr_full_task_metadata",
      });
      expect(sentPrompt()).toContain(`Task:\n${task}`);
    });
  });

  it("caps very long tasks sent to the title service", async () => {
    mockThreadMetadata({ title: "Summarize the pasted log" });
    await withTestHarness(async (harness) => {
      await generateThreadMetadataWithOutcome(harness.deps, {
        input: textInput(
          `Summarize the errors in this log: ${"x".repeat(10_000)}`,
        ),
        threadId: "thr_capped_task_metadata",
      });
      const prompt = sentPrompt();
      expect(prompt).toContain(
        `Task:\nSummarize the errors in this log: ${"x".repeat(3000)}`,
      );
      expect(prompt).toContain(`${"x".repeat(100)}...`);
      expect(prompt).not.toContain("x".repeat(4000));
    });
  });

  it.each(["调", "𠮷"])(
    "preserves the full task after stripping commands containing %s",
    async (character) => {
      mockThreadMetadata({ title: "Investigate the reported issue" });
      await withTestHarness(async (harness) => {
        const input = skillInput("review", ` ${character.repeat(60)}`);
        const original = structuredClone(input);
        await generateThreadMetadataWithOutcome(harness.deps, {
          input,
          threadId: "thr_unicode_skill_metadata",
        });
        const prompt = sentPrompt();
        expect(prompt).toContain(
          "The prompt invokes these commands or skills: /review.",
        );
        expect(prompt).toContain(`Task:\n${character.repeat(60)}`);
        expect(input).toEqual(original);
      });
    },
  );

  it.each(["weekly-report", `generate-${"weekly-".repeat(12)}report`])(
    "titles a bare skill invocation %s from what the skill does",
    async (name) => {
      mockThreadMetadata({ title: "Generate the weekly report" });
      await withTestHarness(async (harness) => {
        await expect(
          generateThreadMetadataWithOutcome(harness.deps, {
            input: skillInput(name),
            threadId: "thr_bare_skill_metadata",
          }),
        ).resolves.toMatchObject({
          metadata: { title: "Generate the weekly report" },
        });
        expect(sentPrompt()).toContain(
          `The prompt invokes these commands or skills: /${name}.`,
        );
        expect(sentPrompt()).toContain(`Task:\n/${name}`);
      });
    },
  );

  it("reports a failed title generation without retrying the same service", async () => {
    completeTitle.mockRejectedValue(new Error("metadata failed"));
    await withTestHarness(async (harness) => {
      await expect(
        generateThreadMetadataWithOutcome(harness.deps, {
          input: textInput("Improve failed metadata generation behavior"),
          threadId: "thr_failed_metadata",
        }),
      ).resolves.toMatchObject({
        metadata: null,
        reason: "failed",
      });
      expect(completeTitle).toHaveBeenCalledTimes(1);
      expect(sentPrompt()).not.toContain(
        "The prompt invokes these commands or skills",
      );
    });
  });
});
