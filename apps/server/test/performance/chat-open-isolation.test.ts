import {
  existsSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { expect, it } from "vitest";
import { z } from "zod";
import { getAppSettings, setAppSettings } from "@omnyo/db";
import { threadTimelineResponseSchema } from "@omnyo/server-contract";
import { createApp } from "../../src/server.js";
import { listBundledPluginRegistrations } from "../../src/services/plugins/builtin-registry.js";
import { createTestAppHarness } from "../helpers/test-app.js";
import { seedPrimaryHost } from "../helpers/seed.js";

const fixtureSchema = z.object({
  owner: z.literal("chat-open-isolation"),
  directory: z.string(),
  temporaryRoot: z.string(),
  databasePath: z.string(),
  hostId: z.string(),
  projectId: z.string(),
  heavyId: z.string(),
  heavyMaxSeq: z.number(),
  probe: z.boolean().default(false),
  small: z.array(z.object({ id: z.string(), text: z.string() })).length(5),
});

it.skipIf(!process.env.OMNYO_CHAT_OPEN_FIXTURE)(
  "opens cold chats in Chrome while another file-backed history is loading",
  async () => {
    const manifest = process.env.OMNYO_CHAT_OPEN_FIXTURE;
    const output = process.env.OMNYO_FRONTEND_MEASUREMENT_OUTPUT;
    const appDist = process.env.OMNYO_FRONTEND_APP_DIST;
    const modulePath = process.env.OMNYO_FRONTEND_PLAYWRIGHT_MODULE;

    if (!manifest || !output || !appDist || !modulePath)
      throw new Error(
        "Expected prepared fixture, output, app and Chrome module",
      );

    const fixture = fixtureSchema.parse(
      JSON.parse(readFileSync(manifest, "utf8")),
    );

    if (
      realpathSync(dirname(fixture.directory)) !==
        realpathSync(fixture.temporaryRoot) ||
      !basename(fixture.directory).startsWith("omnyo-chat-open-")
    )
      throw new Error("Fixture is outside its disposable owner directory");

    if (join(fixture.directory, "app.db") !== fixture.databasePath)
      throw new Error("Fixture database has a different owner");

    const paths = [
      "src/services/threads/timeline-page-builder.ts",
      "src/services/threads/timeline.ts",
      "../../packages/db/src/data/events.ts",
    ];

    const bindings = () =>
      paths.map((path) => ({
        path,
        sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
      }));

    const source = bindings();

    const harness = await createTestAppHarness({
      databaseSource: fixture.databasePath,
    });

    seedPrimaryHost(harness.deps, fixture.hostId);

    harness.db.$client
      .prepare("UPDATE threads SET archived_at = ? WHERE id = ?")
      .run(Date.now(), fixture.heavyId);
    setAppSettings(harness.db, {
      ...getAppSettings(harness.db),
      onboardingCompletedAt: "2026-10-21T00:00:00.000Z",
    });
    const app = createApp(harness.deps, { staticDir: resolve(appDist) });
    await app.pluginService.start({
      hold: {
        sources: listBundledPluginRegistrations().map(
          (p) => `builtin:${p.name}`,
        ),
        detail: "Inert local history acceptance",
        isActive: async () => true,
      },
    });

    const server = serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: app.app.fetch,
    });

    app.injectWebSocket(server);
    const { chromium } = await import(modulePath);

    const browser = await chromium.launch({
      headless: true,
      executablePath:
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    });

    const results: {
      chat: number;
      visibleMs: number;
      heavyPending: boolean;
    }[] = [];

    let heavy: Promise<void> | null = null;
    let heavyFinished = false;
    let status = "failed";
    let heavyMs = 0;
    const errors: string[] = [];
    const reads: { path: string; status: number; error: string | null }[] = [];
    let pageState: { url: string; text: string } | null = null;

    try {
      const address = server.address();

      if (!address || typeof address === "string")
        throw new Error("Missing test port");
      const origin = `http://127.0.0.1:${address.port}`;
      await Promise.all(
        fixture.small.slice(0, 2).map(async (chat) => {
          const response = await fetch(
            `${origin}/api/v1/threads/${chat.id}/timeline?summaryOnly=true&deferContent=true`,
            { signal: AbortSignal.timeout(60_000) },
          );

          expect(response.status).toBe(200);
          await response.arrayBuffer();
        }),
      );

      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
      });

      await context.route(
        (url: URL) => url.origin !== origin,
        (route: any) => route.abort(),
      );
      const page = await context.newPage();
      page.on("pageerror", (error: Error) => errors.push(error.message));
      page.on("response", async (response: any) => {
        const path = new URL(response.url()).pathname;

        if (!path.startsWith("/api/v1/") || !path.endsWith("/timeline")) return;
        reads.push({
          path,
          status: response.status(),
          error:
            response.status() < 400
              ? null
              : (await response.text()).slice(0, 1000),
        });
      });
      const first = fixture.small[0]!;
      await page.goto(
        `${origin}/projects/${fixture.projectId}/threads/${first.id}`,
      );
      await page
        .getByText(first.text, { exact: true })
        .waitFor({ state: "visible", timeout: 20_000 });

      if (fixture.probe) {
        status = "probe-passed";

        return;
      }

      const heavyStarted = performance.now();
      heavy = fetch(
        `${origin}/api/v1/threads/${fixture.heavyId}/timeline?deferContent=true&includeNestedRows=true`,
        {
          signal: AbortSignal.timeout(45_000),
        },
      ).then(async (response) => {
        expect(response.status).toBe(200);

        const timeline = threadTimelineResponseSchema.parse(
          await response.json(),
        );

        expect(timeline.maxSeq).toBe(fixture.heavyMaxSeq);
        heavyMs = performance.now() - heavyStarted;
        heavyFinished = true;
      });

      const settled = heavy.then(
        () => null,
        (error: unknown) => error,
      );

      await new Promise((done) => setTimeout(done, 30));

      for (const [index, chat] of fixture.small.slice(2).entries()) {
        expect(heavyFinished).toBe(false);
        const start = performance.now();
        await page.goto(
          `${origin}/projects/${fixture.projectId}/threads/${chat.id}`,
          { waitUntil: "domcontentloaded" },
        );
        await page
          .getByText(chat.text, { exact: true })
          .waitFor({ state: "visible", timeout: 5_000 });
        const visibleMs = performance.now() - start;
        results.push({
          chat: index + 1,
          visibleMs,
          heavyPending: !heavyFinished,
        });
        expect(heavyFinished).toBe(false);
        expect(visibleMs).toBeLessThan(2_000);
      }

      await page.screenshot({
        path: `${output}.jpg`,
        type: "jpeg",
        quality: 70,
      });
      const failure = await settled;

      if (failure !== null) throw failure;
      expect(bindings()).toEqual(source);
      expect(errors).toEqual([]);
      status = "passed";
    } finally {
      await heavy?.catch(() => {});

      const page = browser
        .contexts()
        .flatMap((context: any) => context.pages())
        .at(-1);

      if (page) {
        await page.screenshot({
          path: `${output}.jpg`,
          type: "jpeg",
          quality: 70,
        });
        pageState = await page.evaluate(() => ({
          url: location.pathname,
          text: document.body.innerText.slice(0, 2500),
        }));
      }

      await browser.close();
      await app.pluginService.stop();
      await app.closeWebSockets();
      await new Promise<void>((done, reject) =>
        server.close((error) => (error ? reject(error) : done())),
      );
      await harness.cleanup();
      harness.db.$client.close();
      writeFileSync(
        output,
        JSON.stringify(
          {
            status,
            source,
            results,
            heavyMs,
            errors,
            reads,
            pageState,
            limits:
              "Local Chrome and inert SQLite history; not live VPS or native-device proof",
          },
          null,
          2,
        ),
      );
      rmSync(fixture.directory, { recursive: true });
      writeFileSync(
        `${manifest}.storage.json`,
        JSON.stringify(
          {
            owner: fixture.owner,
            directory: fixture.directory,
            removed: fixture.directory,
            absent: !existsSync(fixture.directory),
            state: "closed",
            retained: [manifest, output],
          },
          null,
          2,
        ),
      );
    }
  },
  120_000,
);
