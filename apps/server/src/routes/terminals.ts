import {
  publicApiRoutes,
  typedRoutes,
  type PublicApiSchema,
} from "@omnyo/server-contract";
import type { Hono } from "hono";
import { ApiError } from "../errors.js";
import { callHostOnlineRpc } from "../services/hosts/online-rpc.js";
import type { AppDeps } from "../types.js";

const TERMINAL_FOREGROUND_TIMEOUT_MS = 5_000;

export function registerTerminalRoutes(app: Hono, deps: AppDeps): void {
  const { get, patch, post } = typedRoutes<PublicApiSchema>(app, {
    onValidationError: (msg) => new ApiError(400, "invalid_request", msg),
  });

  const routes = publicApiRoutes.terminals;

  get(routes.list, (context, query) => {
    const sessions = deps.terminalSessions.listTerminals({ query });

    return context.json({ sessions });
  });

  post(routes.create, async (context, payload) => {
    const session = await deps.terminalSessions.createTerminal({ payload });

    return context.json(session, 201);
  });

  get(routes.get, (context) => {
    const session = deps.terminalSessions.getTerminal({
      terminalId: context.req.param("terminalId"),
    });

    return context.json(session);
  });

  patch(routes.update, (context, payload) => {
    const session = deps.terminalSessions.renameTerminal({
      payload,
      terminalId: context.req.param("terminalId"),
    });

    return context.json(session);
  });

  post(routes.restart, async (context) => {
    const session = await deps.terminalSessions.restartTerminal({
      terminalId: context.req.param("terminalId"),
    });

    return context.json(session, 201);
  });

  post(routes.close, async (context, payload) => {
    const session = await deps.terminalSessions.closeTerminal({
      payload,
      terminalId: context.req.param("terminalId"),
    });

    return context.json(session);
  });

  post(routes.input, (context, payload) => {
    const session = deps.terminalSessions.sendTerminalInput({
      payload,
      terminalId: context.req.param("terminalId"),
    });

    return context.json(session);
  });

  post(routes.resize, (context, payload) => {
    const session = deps.terminalSessions.resizeTerminal({
      payload,
      terminalId: context.req.param("terminalId"),
    });

    return context.json(session);
  });

  get(routes.foreground, async (context) => {
    const session = deps.terminalSessions.getTerminal({
      terminalId: context.req.param("terminalId"),
    });

    if (session.status !== "running") return context.json({ state: "idle" });

    const foreground = await callHostOnlineRpc(deps, {
      hostId: session.hostId,
      timeoutMs: TERMINAL_FOREGROUND_TIMEOUT_MS,
      command: { type: "terminal.foreground", terminalId: session.id },
    });

    return context.json(foreground);
  });

  get(routes.output, async (context, query) => {
    const output = await deps.terminalSessions.readTerminalOutput({
      query,
      terminalId: context.req.param("terminalId"),
    });

    return context.json(output);
  });
}
