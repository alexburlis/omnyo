import { z } from "zod";
import { incidentSchema, sentryProjectSchema, type Incident, type Route } from "../contract";
import { allEnvironments, scanScope } from "./route-scope";
import { diagnosticsReleaseSchema } from "./repair-result-contract";

export class SentryFailure extends Error {
  constructor(
    public code: string,
    public retryAt: number | null = null,
  ) {
    super(code);
    this.name = "SentryFailure";
  }
}

const issueSchema = z.object({
  id: z.string().regex(/^\d+$/u),
  shortId: z.string().regex(/^[A-Za-z0-9_-]+$/u),
  project: z.object({ id: z.string() }),
  level: z.enum(["debug", "info", "warning", "error", "fatal"]),
  status: z.string().max(40),
  statusDetails: z
    .object({ ignoreUntil: z.iso.datetime({ offset: true }).nullish() })
    .passthrough()
    .nullish(),
  substatus: z.string().max(80).default("ongoing"),
  metadata: z.object({ type: z.string().max(100).optional() }).default({}),
  firstSeen: z.iso.datetime({ offset: true }),
  lastSeen: z.iso.datetime({ offset: true }),
  lastRelease: z
    .object({ version: z.string().max(200) })
    .nullable()
    .optional(),
});

const issuesSchema = z.array(issueSchema).max(100);

const releaseSchema = z.object({
  version: z.string(),
  projects: z.array(z.object({ id: z.union([z.string(), z.number()]) })),
  lastCommit: z
    .object({ id: z.string(), repository: z.object({ name: z.string() }).nullish() })
    .nullish(),
});

const deploymentsSchema = z
  .array(
    z.object({
      environment: z.string().nullable(),
      dateFinished: z.iso.datetime({ offset: true }),
    }),
  )
  .max(100);

const releaseEventsSchema = z.object({
  data: z.array(z.object({ release: z.string(), environment: z.string() })).max(1),
});

const noteSchema = z.object({
  type: z.string(),
  data: z.object({ text: z.string().optional() }),
});

const commentsSchema = z.array(noteSchema).max(100);

const projectPageSchema = z
  .array(
    sentryProjectSchema.strip().extend({
      slug: z.string().max(100),
      name: z.string().max(200),
    }),
  )
  .max(100);

type SentryIssue = z.infer<typeof issueSchema>;

function issueLink(organization: string, id: string): string {
  return "https://" + organization + ".sentry.io/issues/" + id + "/";
}

function incidentFromIssue(route: Route, issue: SentryIssue, exceptionType: string): Incident {
  return incidentSchema.parse({
    key: route.organization + ":" + issue.id,
    id: issue.id,
    shortId: issue.shortId,
    organization: route.organization,
    projectId: issue.project.id,
    url: issueLink(route.organization, issue.id),
    level: issue.level,
    exceptionType,
    firstSeen: issue.firstSeen,
    lastSeen: issue.lastSeen,
    status: issue.status,
    substatus: issue.substatus,
    release: issue.lastRelease?.version ?? null,
    environment: route.environment,
    matchedRouteIds: [route.id],
  });
}

type Page = { incidents: Incident[]; nextCursor: string | null; oldestSeen: string | null };

export function rateLimited(transport: typeof fetch): typeof fetch {
  const waiting: Array<() => void> = [];
  let active = 0;
  let nextStart = 0;

  return async (input, init) => {
    while (active >= 8) await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
    const now = Date.now();
    const startAt = Math.max(now, nextStart);
    nextStart = startAt + 125;

    try {
      if (startAt > now) await new Promise((resolve) => setTimeout(resolve, startAt - now));

      return await transport(input, init);
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

export class SentryClient {
  private origin: string;
  constructor(
    apiOrigin: string,
    private credential: string,
    private transport: typeof fetch = fetch,
  ) {
    const url = new URL(apiOrigin);

    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
      throw new SentryFailure("invalid-origin");
    this.origin = url.origin;
  }

  private async request(
    url: URL,
    mutation?: { method: "PUT" | "POST"; body: string },
    allowMissing = false,
  ) {
    let response: Response;

    const headers = new Headers({
      authorization: "Bearer " + this.credential,
      accept: "application/json",
    });

    if (mutation) headers.set("content-type", "application/json");

    try {
      response = await this.transport(url, {
        headers,
        ...mutation,
        redirect: "error",
        signal: AbortSignal.timeout(20000),
      });
    } catch {
      throw new SentryFailure("network-failure");
    }

    if (response.status === 401 || response.status === 403)
      throw new SentryFailure("access-denied");

    if (response.status === 429) {
      const reset = Number(response.headers.get("x-sentry-rate-limit-reset"));
      throw new SentryFailure("rate-limited", reset > 0 ? reset * 1000 : Date.now() + 60000);
    }

    if (!response.ok && !(allowMissing && response.status === 404))
      throw new SentryFailure("provider-failure");

    return response;
  }

  private issueAddress(route: Route, id: string) {
    if (!/^\d+$/u.test(id) || !/^[a-z0-9-]+$/u.test(route.organization))
      throw new SentryFailure("invalid-issue");

    return new URL(
      "/api/0/organizations/" + route.organization + "/issues/" + id + "/",
      this.origin,
    );
  }

  async resolve(route: Route, id: string): Promise<void> {
    const url = this.issueAddress(route, id);
    const before = await this.readIssue(route, id);

    if (before.status === "resolved") return;
    let failure: SentryFailure | null = null;

    try {
      await this.request(url, { method: "PUT", body: JSON.stringify({ status: "resolved" }) });
    } catch (error) {
      if (!(error instanceof SentryFailure)) throw error;
      failure = error;
    }

    const after = await this.readIssue(route, id);

    if (after.status !== "resolved") throw failure ?? new SentryFailure("resolution-not-confirmed");
  }

  async diagnosticReleaseState(
    route: Route,
    version: string,
    commit: string,
  ): Promise<"waiting" | "shipped" | "identity-unconfirmed"> {
    const parsedVersion = diagnosticsReleaseSchema.parse(version);

    if (version === commit || version === route.githubRepository?.split("/")[1] + "@" + commit)
      return (await this.diagnosticsReleaseObserved(route, version)) ? "shipped" : "waiting";

    const url = new URL(
      "/api/0/organizations/" +
        route.organization +
        "/releases/" +
        encodeURIComponent(parsedVersion) +
        "/",
      this.origin,
    );

    const response = await this.request(url, undefined, true);

    if (response.status === 404) return "waiting";
    const parsed = releaseSchema.safeParse(await response.json().catch(() => null));

    if (!parsed.success) throw new SentryFailure("release-proof-unavailable");
    const release = parsed.data;

    // The deploy serializer has no project field. Only a single-project release can
    // bind an environment's deployment to this exact issue project.
    if (
      release.version !== version ||
      release.projects.length !== 1 ||
      String(release.projects[0]?.id) !== route.sentryProjectId
    )
      return "identity-unconfirmed";

    const source = release.lastCommit;

    if (
      source?.id !== commit ||
      source.repository?.name.toLowerCase() !== route.githubRepository?.toLowerCase()
    )
      return "identity-unconfirmed";

    for await (const deploys of this.pages(
      new URL("deploys/", url),
      deploymentsSchema,
      5,
      "deployments-too-large",
    ))
      if (
        deploys.some(
          (deploy) =>
            deploy.environment === route.environment &&
            Date.parse(deploy.dateFinished) <= Date.now(),
        )
      )
        return "shipped";

    return "waiting";
  }

  private async diagnosticsReleaseObserved(route: Route, version: string) {
    const url = new URL("/api/0/organizations/" + route.organization + "/events/", this.origin);
    const filters = ["release:" + JSON.stringify(version)];

    if (route.service) filters.push("service:" + JSON.stringify(route.service));

    if (route.channel) filters.push("channel:" + JSON.stringify(route.channel));
    url.searchParams.set("project", route.sentryProjectId);
    url.searchParams.set("environment", route.environment);
    url.searchParams.set("dataset", "errors");
    url.searchParams.set("query", filters.join(" "));
    url.searchParams.set("statsPeriod", "14d");
    url.searchParams.set("per_page", "1");
    url.searchParams.append("field", "release");
    url.searchParams.append("field", "environment");

    const parsed = releaseEventsSchema.safeParse(
      await (await this.request(url)).json().catch(() => null),
    );

    if (!parsed.success) throw new SentryFailure("release-telemetry-unavailable");

    return parsed.data.data.some(
      (event) => event.release === version && event.environment === route.environment,
    );
  }

  async diagnosticsIssueState(route: Route, id: string) {
    const issue = await this.readIssue(route, id);

    return {
      status: issue.status,
      until: issue.statusDetails?.ignoreUntil ?? null,
      hasCondition: Object.keys(issue.statusDetails ?? {}).length > 0,
    };
  }

  async setDiagnosticsPause(
    route: Route,
    id: string,
    minutes: number | null,
    previousUntil: string | null,
  ) {
    const before = await this.diagnosticsIssueState(route, id);

    if (
      previousUntil
        ? before.status !== "ignored" || before.until !== previousUntil
        : before.status !== "unresolved" || before.hasCondition
    )
      throw new SentryFailure("diagnostics-pause-ownership-changed");

    const body =
      minutes === null ? { status: "unresolved" } : { status: "ignored", ignoreDuration: minutes };

    const response = await this.request(this.issueAddress(route, id), {
      method: "PUT",
      body: JSON.stringify(body),
    });

    const receipt = issueSchema
      .pick({ id: true, project: true, status: true, statusDetails: true })
      .safeParse(await response.json().catch(() => null));

    const expected = minutes === null ? "unresolved" : "ignored";

    if (
      !receipt.success ||
      receipt.data.id !== id ||
      receipt.data.project.id !== route.sentryProjectId ||
      receipt.data.status !== expected
    )
      throw new SentryFailure("diagnostics-pause-write-unconfirmed");

    const until = receipt.data.statusDetails?.ignoreUntil ?? null;
    const readback = await this.diagnosticsIssueState(route, id);

    if (
      readback.status !== expected ||
      readback.until !== until ||
      (minutes === null ? until !== null : !until || Date.parse(until) <= Date.now())
    )
      throw new SentryFailure("diagnostics-pause-readback-unconfirmed");

    return until;
  }

  private async hasNote(url: URL, marker: string) {
    const activityUrl = new URL("activities/", url);

    const activity = z
      .object({ activity: z.array(noteSchema).max(1000) })
      .safeParse(await (await this.request(activityUrl)).json().catch(() => null));

    if (!activity.success) throw new SentryFailure("invalid-response");

    if (
      activity.data.activity.some((row) => row.type === "note" && row.data.text?.includes(marker))
    )
      return true;

    for await (const notes of this.pages(
      new URL("comments/", url),
      commentsSchema,
      10,
      "notes-too-large",
    ))
      if (notes.some((row) => row.type === "note" && row.data.text?.includes(marker))) return true;

    return false;
  }

  async note(route: Route, id: string, text: string, marker: string): Promise<void> {
    const url = this.issueAddress(route, id);

    if (!/^[A-Za-z0-9:_-]{1,160}$/u.test(marker) || !text.trim() || text.length > 8000)
      throw new SentryFailure("invalid-note");
    const token = "[omnyo:" + marker + "]";
    await this.readIssue(route, id);

    if (await this.hasNote(url, token)) return;
    let failure: SentryFailure | null = null;

    try {
      await this.request(new URL("comments/", url), {
        method: "POST",
        body: JSON.stringify({ text: text + "\n\n" + token }),
      });
    } catch (error) {
      if (!(error instanceof SentryFailure)) throw error;
      failure = error;
    }

    if (!(await this.hasNote(url, token))) throw failure ?? new SentryFailure("note-not-confirmed");
  }

  async projects(organization: string) {
    if (!/^[a-z0-9-]+$/u.test(organization)) throw new SentryFailure("invalid-organization");
    const url = new URL("/api/0/organizations/" + organization + "/projects/", this.origin);
    const projects = new Map<string, z.infer<typeof sentryProjectSchema>>();

    for await (const rows of this.pages(url, projectPageSchema, 100, "catalog-too-large"))
      for (const row of rows) projects.set(row.id, row);

    return [...projects.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  private async *pages<Schema extends z.ZodType>(
    url: URL,
    schema: Schema,
    limit: number,
    limitError: string,
  ) {
    url.searchParams.set("per_page", "100");
    const cursors = new Set<string>();

    for (let page = 0; page < limit; page++) {
      const response = await this.request(url);
      const parsed = schema.safeParse(await response.json().catch(() => null));

      if (!parsed.success) throw new SentryFailure("invalid-response");
      yield parsed.data;

      const next = this.nextCursor(response, url);

      if (!next) return;

      if (cursors.has(next)) throw new SentryFailure("repeated-pagination");
      cursors.add(next);
      url.searchParams.set("cursor", next);
    }

    throw new SentryFailure(limitError);
  }

  private nextCursor(response: Response, url: URL) {
    for (const link of (response.headers.get("link") ?? "").split(",")) {
      if (!/rel="next"/u.test(link) || !/results="true"/u.test(link)) continue;
      const match = /<([^>]+)>/u.exec(link);

      if (!match?.[1]) throw new SentryFailure("unsafe-pagination");
      const next = new URL(match[1], this.origin);
      const cursor = next.searchParams.get("cursor");

      if (
        next.origin !== this.origin ||
        next.pathname !== url.pathname ||
        !cursor ||
        cursor.length > 500
      )
        throw new SentryFailure("unsafe-pagination");

      return cursor;
    }

    return null;
  }

  async page(
    route: Route,
    cursor: string | null,
    before: string | null,
    errorOnly = true,
  ): Promise<Page> {
    const scope = scanScope(route);

    const url = new URL(
      "/api/0/organizations/" + encodeURIComponent(scope.organization) + "/issues/",
      this.origin,
    );

    url.searchParams.set("project", scope.sentryProjectId);

    if (scope.environment !== allEnvironments)
      url.searchParams.append("environment", scope.environment);
    url.searchParams.set("sort", "date");
    url.searchParams.set("per_page", "100");
    const query = ["is:unresolved", scope.query];

    if (errorOnly) query.push("issue.category:error");

    if (scope.service) query.push("service:" + JSON.stringify(scope.service));

    if (scope.channel) query.push("channel:" + JSON.stringify(scope.channel));

    if (scope.releases.length)
      query.push(
        "(" + scope.releases.map((value) => "release:" + JSON.stringify(value)).join(" OR ") + ")",
      );

    if (before) query.push("lastSeen:<=" + before);
    url.searchParams.set("query", query.join(" "));

    if (cursor) url.searchParams.set("cursor", cursor);
    const response = await this.request(url);
    const parsed = issuesSchema.safeParse(await response.json().catch(() => null));

    if (!parsed.success) throw new SentryFailure("invalid-response");
    const incidents: Incident[] = [];

    for (const issue of parsed.data) {
      if (
        issue.status !== "unresolved" ||
        issue.project.id !== scope.sentryProjectId ||
        !scope.levels.includes(issue.level)
      )
        continue;

      const exceptionType =
        issue.metadata.type && /^[A-Za-z_][A-Za-z0-9_.:]{0,99}$/u.test(issue.metadata.type)
          ? issue.metadata.type
          : "Error";

      incidents.push(incidentFromIssue(route, issue, exceptionType));
    }

    const nextCursor = this.nextCursor(response, url);

    return { incidents, nextCursor, oldestSeen: parsed.data.at(-1)?.lastSeen ?? null };
  }

  async issue(route: Route, issueUrl: string): Promise<Incident> {
    const url = new URL(issueUrl);
    const match = /\/issues\/(\d+)\/?$/u.exec(url.pathname);

    if (
      url.protocol !== "https:" ||
      !url.hostname.endsWith(".sentry.io") ||
      !match?.[1] ||
      url.search ||
      url.hash
    )
      throw new SentryFailure("invalid-issue-url");

    return incidentFromIssue(route, await this.readIssue(route, match[1]), "Error");
  }

  private async readIssue(route: Route, id: string): Promise<SentryIssue> {
    const response = await this.request(this.issueAddress(route, id));
    const parsed = issueSchema.safeParse(await response.json().catch(() => null));

    if (
      !parsed.success ||
      parsed.data.id !== id ||
      parsed.data.project.id !== route.sentryProjectId
    )
      throw new SentryFailure("issue-outside-route");

    return parsed.data;
  }
}
