import { Hono, type MiddlewareHandler } from "hono";
import type { RelayDb } from "../db.js";
import type { RelayAuthService } from "../auth/auth-service.js";
import type { RevocationJournalInput } from "../gate/revocation.js";
import { createTokenBucketRateLimiter } from "../rate-limit.js";
import { linkRequestOrigin } from "./account.js";
import { escapeHtml } from "./html.js";
import {
  weeklyCatalogShareId,
  readPublishedWeeklyFeed,
} from "./catalog-workflow.js";
import { sameOriginViolation } from "./same-origin.js";
import {
  listWorkflowShares,
  readWorkflowShare,
  revokeWorkflowShare,
  shareOwnerAllowed,
} from "../workflow-shares.js";

export function createWorkflowShareApp(input: {
  db: RelayDb;
  auth: RelayAuthService;
  origin: string;
  now: () => number;
  record: (entry: RevocationJournalInput) => void;
}): Hono {
  const app = new Hono();

  const reads = createTokenBucketRateLimiter(
    { limit: 60, periodMs: 60000 },
    input.now,
  );

  const writes = createTokenBucketRateLimiter(
    { limit: 10, periodMs: 60000 },
    input.now,
  );

  const guard: MiddlewareHandler = async (c, next) => {
    c.header("cache-control", "no-store");
    c.header("referrer-policy", "no-referrer");
    c.header("x-robots-tag", "noindex, nofollow");
    c.header("x-content-type-options", "nosniff");
    const ip = linkRequestOrigin(c.req.raw.headers)?.clientIp;

    if (!ip) return c.json({ error: "client-ip-unavailable" }, 500);

    if (!(await reads.limit({ key: ip })).success)
      return c.json({ error: "rate-limited" }, 429);

    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      if (
        c.req.header("origin") !== input.origin ||
        sameOriginViolation(c.req.raw, input.origin)
      )
        return c.json({ error: "forbidden" }, 403);
      const session = await input.auth.resolveSession(c.req.raw.headers);

      if (!session) return c.json({ error: "unauthorized" }, 401);

      if (!shareOwnerAllowed(input.db, session.user.id))
        return c.json({ error: "verified-account-required" }, 403);

      if (!(await writes.limit({ key: session.user.id })).success)
        return c.json({ error: "rate-limited" }, 429);
    }

    await next();
  };

  for (const path of [
    "/api/workflow-shares",
    "/api/workflow-shares/*",
    "/dashboard/workflows",
    "/dashboard/workflows/*",
  ])
    app.use(path, guard);
  app.get("/api/workflow-shares/:id", (c) => {
    const share = readWorkflowShare(input.db, c.req.param("id"), input.now());

    return share ? c.json(share.metadata) : c.json({ error: "not-found" }, 404);
  });
  app.get("/api/workflow-shares/:id/file", async (c) => {
    const id = c.req.param("id");

    const bytes =
      id === weeklyCatalogShareId
        ? await readPublishedWeeklyFeed()
        : readWorkflowShare(input.db, id, input.now())?.bytes;

    if (!bytes) return c.json({ error: "not-found" }, 404);

    return new Response(new Uint8Array(bytes), {
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": 'attachment; filename="workflow.omnyoworkflow"',
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "x-robots-tag": "noindex, nofollow",
      },
    });
  });
  app.get("/api/workflow-shares", async (c) => {
    const session = await input.auth.resolveSession(c.req.raw.headers);

    if (!session) return c.json({ error: "unauthorized" }, 401);

    if (!shareOwnerAllowed(input.db, session.user.id))
      return c.json({ error: "forbidden" }, 403);

    return c.json({
      shares: listWorkflowShares(input.db, session.user.id, input.now()),
    });
  });
  app.post("/api/workflow-shares/:id/revoke", async (c) => {
    const session = await input.auth.resolveSession(c.req.raw.headers);

    if (!session) return c.json({ error: "unauthorized" }, 401);

    return revokeWorkflowShare(input.db, input.record, {
      userId: session.user.id,
      id: c.req.param("id"),
      now: input.now(),
    })
      ? c.json({ revoked: true })
      : c.json({ error: "not-found" }, 404);
  });
  app.get("/dashboard/workflows", async (c) => {
    const session = await input.auth.resolveSession(c.req.raw.headers);

    if (!session)
      return c.redirect("/sign-in?next=%2Fdashboard%2Fworkflows", 303);

    if (!shareOwnerAllowed(input.db, session.user.id))
      return c.json({ error: "verified-account-required" }, 403);

    const rows = listWorkflowShares(input.db, session.user.id, input.now())
      .map(
        (share) =>
          `<li><a href="https://omnyohq.com/w/${share.id}">${escapeHtml(share.title)}</a> — expires ${new Date(share.expiresAt).toISOString().slice(0, 10)}<form method="post" action="/dashboard/workflows/${share.id}/revoke"><button>Revoke link</button></form></li>`,
      )
      .join("");

    return c.html(
      `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>Workflow links — Omnyo</title></head><body><main><a href="/dashboard">Account</a><h1>Existing workflow links</h1><p>Revoke any links you no longer want to use.</p><ul>${rows}</ul><a href="https://omnyohq.com/privacy">Privacy</a></main></body></html>`,
    );
  });
  app.post("/dashboard/workflows/:id/revoke", async (c) => {
    const session = await input.auth.resolveSession(c.req.raw.headers);

    if (!session) return c.json({ error: "unauthorized" }, 401);

    if (
      !revokeWorkflowShare(input.db, input.record, {
        userId: session.user.id,
        id: c.req.param("id"),
        now: input.now(),
      })
    )
      return c.json({ error: "not-found" }, 404);

    return c.redirect("/dashboard/workflows", 303);
  });

  return app;
}
