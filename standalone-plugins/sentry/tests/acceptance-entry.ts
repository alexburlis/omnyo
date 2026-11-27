import type { PluginApi } from "@omnyo/plugin-sdk";
import { defineRpcContract } from "@omnyo/plugin-sdk";
import { z } from "zod";
import { createSentryPlugin } from "../server";
import { routeSchema, runSchema, statusSchema } from "../contract";
import { sentryIssue } from "./fixtures";

// This entry is compiled only into the explicitly labelled acceptance snapshot.
// It replaces the external Sentry transport; production's server entry never imports it.
const issueId = "987654321";

const organization = "omnyo-local-fixture";

const routeId = "fixture_local";

const contract = defineRpcContract({
  "fixture.prepare": { input: routeSchema, output: runSchema },
  "fixture.clear": { input: z.null(), output: z.object({ cleared: z.literal(true) }) },
  "fixture.identity": {
    input: z.null(),
    output: z.object({ kind: z.literal("sentry-local-acceptance") }),
  },
});

export default async function acceptance(api: PluginApi) {
  await createSentryPlugin(async (input) => {
    const url = new URL(String(input));

    if (
      url.origin !== "https://de.sentry.io" ||
      url.pathname !== "/api/0/organizations/" + organization + "/issues/" + issueId + "/"
    )
      throw new Error("Acceptance transport refuses real Sentry access");

    return new Response(JSON.stringify({ ...sentryIssue(issueId), shortId: "FIXTURE-1" }), {
      headers: { "content-type": "application/json" },
    });
  })(api);

  const status = () =>
    api.sdk.plugins.callRpc({
      pluginId: "sentry",
      method: "status",
      input: null,
      outputSchema: statusSchema,
    });

  api.rpc.register(
    contract,
    {
      "fixture.identity": () => ({ kind: "sentry-local-acceptance" as const }),
      "fixture.prepare": async (route) => {
        const current = await status();

        if (
          route.id !== routeId ||
          route.organization !== organization ||
          route.sentryProjectId !== "100" ||
          route.delivery !== "local" ||
          route.enabled ||
          !route.projectId.startsWith("proj_") ||
          !route.hostId.startsWith("host_") ||
          !route.repositoryPath.includes("/sentry-local-journey-") ||
          !route.repositoryPath.endsWith("/umbrella/client") ||
          route.baseRef !== "main" ||
          route.githubRepository
        )
          throw new Error("Use only the controlled local fixture target");

        if (
          current.routes.some((value) => value.id !== routeId) ||
          current.runs.some((value) => value.route.id !== routeId)
        )
          throw new Error("A different owner has configured this plugin");

        if (current.connected && !current.routes.some((value) => value.id === routeId))
          throw new Error(
            "Preserve the existing connection; acceptance needs an unconfigured plugin",
          );
        await api.sdk.plugins.updateSettings({
          pluginId: "sentry",
          values: { apiToken: "synthetic-local-fixture" },
        });

        if (!current.routes.length)
          await api.sdk.plugins.callRpc({
            pluginId: "sentry",
            method: "routes.save",
            input: route,
            outputSchema: routeSchema,
          });

        return api.sdk.plugins.callRpc({
          pluginId: "sentry",
          method: "investigate",
          input: {
            routeId,
            issueUrl: "https://" + organization + ".sentry.io/issues/" + issueId + "/",
            mode: "local",
          },
          outputSchema: runSchema,
        });
      },
      "fixture.clear": async () => {
        const current = await status();

        if (
          current.routes.some((value) => value.id !== routeId) ||
          current.runs.some(
            (value) =>
              value.route.id !== routeId ||
              ["queued", "preparing", "investigating", "verifying", "publishing"].includes(
                value.state,
              ),
          )
        )
          throw new Error("Preserve active or differently owned work");
        const db = api.storage.database();

        if (db.prepare("SELECT 1 FROM repo_claims LIMIT 1").get())
          throw new Error("The fixture producer has not released execution");
        await api.sdk.plugins.updateSettings({ pluginId: "sentry", values: { apiToken: null } });
        db.transaction(() => {
          db.prepare("DELETE FROM runs WHERE json_extract(payload, '$.route.id')=?").run(routeId);
          db.prepare("DELETE FROM incidents WHERE id=?").run(organization + ":" + issueId);
          db.prepare("DELETE FROM sync_state WHERE id=?").run(routeId);
          db.prepare("DELETE FROM routes WHERE id=?").run(routeId);
        })();

        return { cleared: true as const };
      },
    },
    {
      experimental_discoverable: true,
      experimental_description:
        "Controlled local acceptance fixture only; absent from the production bundle.",
    },
  );
}
