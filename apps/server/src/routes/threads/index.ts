import type { Hono } from "hono";
import type { ServerMaintenance } from "../../services/maintenance/server-maintenance.js";
import type { PluginService } from "../../services/plugins/plugin-service.js";
import type { AppDeps } from "../../types.js";
import { registerThreadActionRoutes } from "./actions.js";
import { registerThreadBaseRoutes } from "./base.js";
import { registerThreadDataRoutes } from "./data.js";
import { registerThreadInteractionRoutes } from "./interactions.js";
import { registerThreadTabRoutes } from "./tabs.js";
import { registerThreadAttentionRoutes } from "../thread-attention.js";
import { registerThreadCommandProofRoutes } from "./command-proofs.js";
import { registerThreadWorkRoutes } from "./work.js";

export function registerThreadRoutes(
  app: Hono,
  deps: AppDeps,
  maintenance: Pick<ServerMaintenance, "getRuntimeId">,
  plugins?: Pick<PluginService, "readThreadBootstrap">,
): void {
  registerThreadBaseRoutes(app, deps, plugins);
  registerThreadActionRoutes(app, deps);
  registerThreadDataRoutes(app, deps, maintenance);
  registerThreadInteractionRoutes(app, deps);
  registerThreadTabRoutes(app, deps);
  registerThreadAttentionRoutes(app, deps);
  registerThreadWorkRoutes(app, deps);
  registerThreadCommandProofRoutes(app, deps);
}
