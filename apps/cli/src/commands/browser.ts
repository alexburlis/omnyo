import { writeFile } from "node:fs/promises";
import { Command } from "commander";
import type {
  ExperimentalDesktopBrowserCookieSyncStatus,
  ExperimentalDesktopBrowserImportOutcome,
  ExperimentalDesktopBrowserImportSources,
  ExperimentalDesktopBrowserScope,
} from "@omnyo/sdk";
import {
  DESKTOP_BROWSER_IMPORT_FAILURE_COPY,
  desktopBrowserImportSourceIdSchema,
} from "@omnyo/host-daemon-contract";
import { action } from "../action.js";
import { createCliOmnyoSdk } from "../client.js";
import { parseDurationMs } from "../duration.js";
import {
  resolveContextThreadId,
  resolveExplicitIdFlag,
} from "../context-env.js";

type CliOmnyoSdk = ReturnType<typeof createCliOmnyoSdk>;

type DesktopWindow = Omit<ExperimentalDesktopBrowserScope, "threadId">;

type ListedDesktopWindow = DesktopWindow & { label: string };

interface InstanceOptions {
  json?: boolean;
  host?: string;
  instance?: string;
  generation?: string;
}

interface ScopeOptions extends InstanceOptions {
  thread?: string;
}

const WINDOW_FLAGS_USAGE =
  "--host <id> --instance <id> --generation <id> (see `omnyo browser instances --host <id>`)";

function selectDesktopWindow(args: {
  windows: readonly ListedDesktopWindow[];
  uncheckedHostIds: readonly string[];
}): DesktopWindow {
  const [only] = args.windows;

  if (
    only !== undefined &&
    args.windows.length === 1 &&
    args.uncheckedHostIds.length === 0
  ) {
    return {
      hostId: only.hostId,
      instanceId: only.instanceId,
      generation: only.generation,
    };
  }

  const unchecked =
    args.uncheckedHostIds.length === 0
      ? ""
      : `\nCould not list desktop windows on: ${args.uncheckedHostIds.join(", ")}`;

  if (args.windows.length === 0) {
    throw new Error(
      `No connected Omnyo desktop window found. Open the Omnyo desktop app or pass ${WINDOW_FLAGS_USAGE}.${unchecked}`,
    );
  }

  const choices = args.windows
    .map(
      (window) =>
        `  --host ${window.hostId} --instance ${window.instanceId} --generation ${window.generation}  ${window.label}`,
    )
    .join("\n");

  throw new Error(
    `Several Omnyo desktop windows are connected; choose one:\n${choices}${unchecked}`,
  );
}

async function resolveDesktopWindow(
  sdk: CliOmnyoSdk,
  options: InstanceOptions,
): Promise<DesktopWindow> {
  const host = resolveExplicitIdFlag({
    flagName: "--host",
    value: options.host,
  });

  if ((options.instance === undefined) !== (options.generation === undefined)) {
    throw new Error("Pass --instance and --generation together.");
  }

  if (options.instance !== undefined && options.generation !== undefined) {
    if (host === undefined) throw new Error("--instance requires --host.");

    return {
      hostId: host,
      instanceId: options.instance,
      generation: options.generation,
    };
  }

  if (host !== undefined) {
    const { instances } = await sdk.experimental_desktopBrowsers.listInstances({
      hostId: host,
    });

    return selectDesktopWindow({ windows: instances, uncheckedHostIds: [] });
  }

  const hostIds = (await sdk.hosts.list())
    .filter((entry) => entry.status === "connected")
    .map((entry) => entry.id);

  const listed = await Promise.allSettled(
    hostIds.map((hostId) =>
      sdk.experimental_desktopBrowsers.listInstances({ hostId }),
    ),
  );

  return selectDesktopWindow({
    windows: listed.flatMap((result) =>
      result.status === "fulfilled" ? result.value.instances : [],
    ),
    uncheckedHostIds: hostIds.filter(
      (_, index) => listed[index]?.status === "rejected",
    ),
  });
}

async function resolveScope(
  sdk: CliOmnyoSdk,
  options: ScopeOptions,
): Promise<ExperimentalDesktopBrowserScope> {
  const threadId =
    resolveExplicitIdFlag({ flagName: "--thread", value: options.thread }) ??
    resolveContextThreadId();

  if (threadId === undefined) {
    throw new Error(
      "Missing thread ID. Pass --thread or run inside an Omnyo thread.",
    );
  }

  return { ...(await resolveDesktopWindow(sdk, options)), threadId };
}

function instanceScoped(command: Command) {
  return command
    .option(
      "--host <id>",
      "Browser host ID; omit to use the only connected desktop window",
    )
    .option("--instance <id>", "Desktop window instance ID")
    .option("--generation <id>", "Desktop connection generation")
    .option("--json", "Print machine-readable JSON output");
}

export function formatImportSources(
  result: ExperimentalDesktopBrowserImportSources,
): string {
  const lines = result.sources.map((source) => {
    const status = source.unavailable ?? "ready";

    const profiles = source.profiles
      .map(
        (profile) =>
          `${profile.directory}${
            profile.name === profile.directory ? "" : ` "${profile.name}"`
          }${profile.cookieCount === undefined ? "" : ` (${profile.cookieCount})`}`,
      )
      .join(", ");

    return `${source.id}  ${status}  ${profiles}`.trimEnd();
  });

  if (lines.length === 0) return "No importable browsers found";

  if (result.recommended !== undefined)
    lines.push(
      `Default browser: --from ${result.recommended.sourceId} --profile ${JSON.stringify(result.recommended.sourceProfileDirectory)}`,
    );

  return lines.join("\n");
}

export function formatImportOutcome(
  outcome: ExperimentalDesktopBrowserImportOutcome,
): string {
  if (!outcome.ok)
    return `Import failed: ${DESKTOP_BROWSER_IMPORT_FAILURE_COPY[outcome.reason]}`;

  const skipped =
    outcome.skipped > 0
      ? `, skipped ${outcome.skipped}${
          outcome.skippedDomains.length > 0
            ? ` (${outcome.skippedDomains.join(", ")})`
            : ""
        }`
      : "";

  return `Imported ${outcome.imported} cookies${skipped}`;
}

export function formatCookieSyncStatus(
  status: ExperimentalDesktopBrowserCookieSyncStatus,
): string {
  if (status.source === null) return "Cookie sync is off";

  const lines = [
    `Cookie sync is on from ${status.source.sourceId} profile "${status.source.sourceProfileDirectory}"`,
  ];

  const run = status.lastRun;

  if (status.running) lines.push("Syncing now");

  if (run === null) lines.push("Last sync: never");
  else if (run.ok)
    lines.push(
      `Last sync: ${new Date(run.at).toISOString()}, imported ${run.imported}, removed ${run.removed}, skipped ${run.skipped}`,
    );
  else
    lines.push(
      `Last sync failed ${new Date(run.at).toISOString()}: ${DESKTOP_BROWSER_IMPORT_FAILURE_COPY[run.reason]}`,
    );

  if (status.nextRunAt !== null)
    lines.push(`Next sync: ${new Date(status.nextRunAt).toISOString()}`);

  return lines.join("\n");
}

function scoped(command: Command) {
  return command
    .option(
      "--host <id>",
      "Browser host ID; omit to use the only connected desktop window",
    )
    .option("--instance <id>", "Desktop window instance ID")
    .option("--generation <id>", "Desktop connection generation")
    .option("--thread <id>", "Owning thread ID; defaults to OMNYO_THREAD_ID")
    .option("--json", "Print machine-readable JSON output");
}

function print(value: object, options: { json?: boolean }, summary: string) {
  console.log(options.json ? JSON.stringify(value) : summary);
}

export function registerBrowserCommands(
  program: Command,
  getUrl: () => string,
) {
  const browser = program
    .command("browser")
    .description("Experimental built-in desktop browser control");

  const sdk = () => createCliOmnyoSdk(getUrl());
  const api = () => sdk().experimental_desktopBrowsers;
  const scope = (options: ScopeOptions) => resolveScope(sdk(), options);

  const desktopWindow = (options: InstanceOptions) =>
    resolveDesktopWindow(sdk(), options);

  instanceScoped(
    browser
      .command("profile-renderer")
      .description(
        "Capture a bounded CPU profile of the Omnyo app shell without changing focus",
      ),
  )
    .option(
      "--duration <duration>",
      "Capture duration; default 2s, minimum 200ms, maximum 5s",
    )
    .action(
      action(async (options: InstanceOptions & { duration?: string }) => {
        const durationMs =
          options.duration === undefined
            ? undefined
            : parseDurationMs({
                allowZero: false,
                defaultUnit: "s",
                label: "--duration",
                value: options.duration,
              });

        if (durationMs !== undefined && (durationMs < 200 || durationMs > 5000))
          throw new Error("--duration must be between 200ms and 5s");

        const profile = await api().profileRenderer({
          ...(await desktopWindow(options)),
          ...(durationMs === undefined ? {} : { durationMs }),
        });

        const lines = profile.hotspots.map(
          (frame) =>
            `${frame.hits}  ${frame.assetPath}:${frame.line}:${frame.column}`,
        );

        print(
          profile,
          options,
          [
            `App renderer: ${profile.totalSamples} samples over ${profile.actualDurationMs.toFixed(0)}ms; ${profile.omittedSamples} omitted`,
            ...lines,
          ].join("\n"),
        );
      }),
    );

  browser
    .command("instances")
    .description("List connected desktop windows on a host")
    .requiredOption("--host <id>", "Browser host ID")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (options: { host: string; json?: boolean }) => {
        const result = await api().listInstances({ hostId: options.host });
        print(
          result,
          options,
          result.instances
            .map(
              (instance) =>
                `${instance.instanceId}  ${instance.generation}  ${instance.label}`,
            )
            .join("\n") || "No connected desktop windows",
        );
      }),
    );
  scoped(
    browser.command("tabs").description("List a thread's native browser tabs"),
  ).action(
    action(async (options: ScopeOptions) => {
      const result = await api().listTabs(await scope(options));
      print(
        result,
        options,
        result.tabs
          .map(
            (tab) =>
              `${tab.tabId}  ${tab.title || tab.url}  ${tab.control?.controllerLabel ?? "Available"}`,
          )
          .join("\n") || "No browser tabs in this thread",
      );
    }),
  );
  scoped(
    browser
      .command("create")
      .description("Create a tab in the Omnyo browser profile"),
  )
    .option("--url <url>", "Initial HTTP(S) URL; defaults to about:blank")
    .option("--reveal", "Show the new native tab")
    .action(
      action(
        async (options: ScopeOptions & { url?: string; reveal?: boolean }) => {
          const result = await api().createTab({
            ...(await scope(options)),
            ...(options.url === undefined ? {} : { url: options.url }),
            ...(options.reveal ? { presentation: "reveal" } : {}),
          });

          print(result, options, `Created tab ${result.tab.tabId}`);
        },
      ),
    );
  scoped(
    browser
      .command("acquire <tabIds...>")
      .description("Acquire exclusive, expiring control of selected tabs"),
  )
    .requiredOption("--controller <label>", "Visible controller name")
    .option(
      "--ttl-ms <ms>",
      "Lease duration; defaults to five minutes, maximum thirty",
    )
    .action(
      action(
        async (
          tabIds: string[],
          options: ScopeOptions & {
            controller: string;
            ttlMs?: string;
          },
        ) => {
          const result = await api().acquireControl({
            ...(await scope(options)),
            tabIds,
            controllerLabel: options.controller,
            ...(options.ttlMs === undefined
              ? {}
              : { ttlMs: Number(options.ttlMs) }),
          });

          print(
            result,
            options,
            `Control lease ${result.leaseId} expires ${new Date(result.expiresAt).toISOString()}`,
          );
        },
      ),
    );
  scoped(
    browser
      .command("connection <leaseId>")
      .description("Write private CDP connection JSON to a new local file"),
  )
    .requiredOption(
      "--output <file>",
      "New credential file (mode 0600); endpoint works only on browser host",
    )
    .action(
      action(
        async (leaseId: string, options: ScopeOptions & { output: string }) => {
          const connection = await api().openConnection({
            ...(await scope(options)),
            leaseId,
          });

          await writeFile(options.output, JSON.stringify(connection), {
            mode: 0o600,
            flag: "wx",
          });
          print(
            {
              path: options.output,
              hostId: connection.hostId,
              expiresAt: connection.expiresAt,
            },
            options,
            `Wrote private connection to ${options.output}`,
          );
        },
      ),
    );
  scoped(
    browser
      .command("release <leaseId>")
      .description("Stop automation and keep tabs open"),
  ).action(
    action(async (leaseId: string, options: ScopeOptions) => {
      print(
        await api().releaseControl({ ...(await scope(options)), leaseId }),
        options,
        "Released browser control",
      );
    }),
  );

  for (const name of ["reveal", "close"] as const) {
    scoped(
      browser
        .command(`${name} <tabId>`)
        .description(
          name === "close"
            ? "Close a native tab"
            : "Reveal a native tab in its desktop window",
        ),
    ).action(
      action(async (tabId: string, options: ScopeOptions) => {
        const input = { ...(await scope(options)), tabId };
        print(
          await (name === "close"
            ? api().closeTab(input)
            : api().revealTab(input)),
          options,
          `${name === "close" ? "Closed" : "Revealed"} tab ${tabId}`,
        );
      }),
    );
  }

  scoped(
    browser
      .command("capture <tabId>")
      .description("Save a native tab screenshot without focusing it"),
  )
    .requiredOption("--output <file>", "New local JPEG file")
    .action(
      action(
        async (tabId: string, options: ScopeOptions & { output: string }) => {
          const capture = await api().captureTab({
            ...(await scope(options)),
            tabId,
          });

          await writeFile(
            options.output,
            Buffer.from(capture.base64, "base64"),
            { flag: "wx", mode: 0o600 },
          );
          print(
            { path: options.output, mimeType: capture.mimeType },
            options,
            `Saved screenshot to ${options.output}`,
          );
        },
      ),
    );
  instanceScoped(
    browser
      .command("import-sources")
      .description(
        "List browsers on the desktop host whose cookies can be imported",
      ),
  ).action(
    action(async (options: InstanceOptions) => {
      const result = await api().listImportSources(
        await desktopWindow(options),
      );

      print(result, options, formatImportSources(result));
    }),
  );
  instanceScoped(
    browser
      .command("import-cookies")
      .description(
        "Copy signed-in cookies from an installed browser into the Omnyo browser",
      ),
  )
    .requiredOption(
      "--from <source>",
      "Source browser ID from `omnyo browser import-sources`",
    )
    .requiredOption(
      "--profile <directory>",
      "Source profile directory as printed by `omnyo browser import-sources`",
    )
    .action(
      action(
        async (
          options: InstanceOptions & {
            from: string;
            profile: string;
          },
        ) => {
          const outcome = await api().importCookies({
            ...(await desktopWindow(options)),
            sourceId: desktopBrowserImportSourceIdSchema.parse(options.from),
            sourceProfileDirectory: options.profile,
          });

          print(outcome, options, formatImportOutcome(outcome));

          if (!outcome.ok) process.exitCode = 1;
        },
      ),
    );

  const cookieSync = browser
    .command("cookie-sync")
    .description(
      "Keep the Omnyo browser signed in by syncing cookies from an installed browser profile on the desktop host",
    );

  const printSync = (
    status: ExperimentalDesktopBrowserCookieSyncStatus,
    options: InstanceOptions,
  ) => {
    print(status, options, formatCookieSyncStatus(status));

    if (status.lastRun?.ok === false) process.exitCode = 1;
  };

  instanceScoped(
    cookieSync
      .command("status")
      .description("Show the sync source, last result and next run"),
  ).action(
    action(async (options: InstanceOptions) => {
      const status = await api().cookieSyncStatus(await desktopWindow(options));

      print(status, options, formatCookieSyncStatus(status));
    }),
  );
  instanceScoped(
    cookieSync
      .command("enable")
      .description(
        "Sync from a source profile now and every 15 minutes; cookies stay on the desktop host",
      ),
  )
    .requiredOption(
      "--from <source>",
      "Source browser ID from `omnyo browser import-sources`",
    )
    .requiredOption(
      "--profile <directory>",
      "Source profile directory as printed by `omnyo browser import-sources`",
    )
    .action(
      action(
        async (
          options: InstanceOptions & { from: string; profile: string },
        ) => {
          printSync(
            await api().configureCookieSync({
              ...(await desktopWindow(options)),
              source: {
                sourceId: desktopBrowserImportSourceIdSchema.parse(
                  options.from,
                ),
                sourceProfileDirectory: options.profile,
              },
            }),
            options,
          );
        },
      ),
    );
  instanceScoped(
    cookieSync
      .command("disable")
      .description("Stop syncing and keep the cookies already imported"),
  ).action(
    action(async (options: InstanceOptions) => {
      printSync(
        await api().configureCookieSync({
          ...(await desktopWindow(options)),
          source: null,
        }),
        options,
      );
    }),
  );
  instanceScoped(
    cookieSync.command("run").description("Sync now and wait for the result"),
  ).action(
    action(async (options: InstanceOptions) => {
      printSync(
        await api().runCookieSync(await desktopWindow(options)),
        options,
      );
    }),
  );
  scoped(
    browser
      .command("watch")
      .description(
        "Print changed tab snapshots every two seconds until interrupted",
      ),
  ).action(
    action(async (options: ScopeOptions) => {
      const resolvedScope = await scope(options);
      await new Promise<void>((resolve, reject) => {
        const subscription = api().subscribe({
          ...resolvedScope,
          onChange: (result) =>
            print(
              result,
              options,
              result.tabs
                .map(
                  (tab) =>
                    `${tab.tabId}  ${tab.title || tab.url}  ${tab.control?.controllerLabel ?? "Available"}`,
                )
                .join("\n") || "No browser tabs in this thread",
            ),
          onError(error) {
            cleanup();
            reject(error);
          },
        });

        const stop = () => {
          cleanup();
          resolve();
        };

        function cleanup() {
          subscription.dispose();
          process.off("SIGINT", stop);
          process.off("SIGTERM", stop);
        }

        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      });
    }),
  );
}
