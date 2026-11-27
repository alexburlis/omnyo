import { describe, expect, it, vi } from "vitest";
import { rateLimited, SentryClient, SentryFailure } from "../src/intake";
import { route, sentryIssue } from "./fixtures";

describe("Sentry request rate", () => {
  it("starts at most eight requests a second and keeps at most eight in flight", async () => {
    vi.useFakeTimers();
    const starts: number[] = [];
    const releases: Array<() => void> = [];

    const gated = rateLimited(async () => {
      starts.push(Date.now());
      await new Promise<void>((resolve) => releases.push(resolve));

      return Response.json([]);
    });

    try {
      const calls = Array.from({ length: 12 }, () => gated("https://de.sentry.io/"));
      await vi.advanceTimersByTimeAsync(5000);
      expect(starts).toHaveLength(8);
      expect(starts.slice(1).every((value, index) => value - starts[index]! >= 125)).toBe(true);

      for (const release of releases.splice(0)) release();
      await vi.advanceTimersByTimeAsync(5000);
      expect(starts).toHaveLength(12);
      expect(starts.slice(1).every((value, index) => value - starts[index]! >= 125)).toBe(true);

      for (const release of releases.splice(0)) release();
      await Promise.all(calls);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Sentry intake HTTP boundary", () => {
  it("lets a workflow inspect every issue category while legacy routes retain error filtering", async () => {
    const requests: URL[] = [];

    const client = new SentryClient("https://de.sentry.io", "synthetic", async (input) => {
      requests.push(new URL(String(input)));

      return Response.json([{ ...sentryIssue(), level: "info" }]);
    });

    const configured = { ...route(), levels: ["info" as const, "error" as const] };
    const page = await client.page(configured, null, null, false);
    expect(page.incidents).toHaveLength(1);
    expect(requests[0]?.searchParams.get("query")).not.toContain("issue.category:error");
    await client.page(configured, null, null);
    expect(requests[1]?.searchParams.get("query")).toContain("issue.category:error");
  });

  it("bounds a page by last-seen time and reports the oldest row it returned", async () => {
    const requests: URL[] = [];

    const client = new SentryClient("https://de.sentry.io", "synthetic", async (input) => {
      requests.push(new URL(String(input)));

      return Response.json([
        { ...sentryIssue("101"), lastSeen: "2026-11-02T00:00:00Z" },
        { ...sentryIssue("102"), level: "warning", lastSeen: "2026-11-01T00:00:00Z" },
      ]);
    });

    const page = await client.page(route(), null, "2026-11-03T00:00:00.000Z");
    expect(requests[0]?.searchParams.get("query")).toContain("lastSeen:<=2026-11-03T00:00:00.000Z");
    expect(page.incidents.map((row) => row.id)).toEqual(["101"]);
    expect(page.oldestSeen).toBe("2026-11-01T00:00:00Z");
  });

  it("uses explicit org/project/environment filters and projects away customer content", async () => {
    const requests: URL[] = [];

    const client = new SentryClient("https://de.sentry.io", "synthetic", async (input, init) => {
      requests.push(new URL(String(input)));
      expect(init?.redirect).toBe("error");

      return Response.json([sentryIssue(), { ...sentryIssue("102"), project: { id: "999" } }]);
    });

    const page = await client.page(route(), null, null);
    expect(requests[0]?.pathname).toBe("/api/0/organizations/acme/issues/");
    expect(requests[0]?.searchParams.get("project")).toBe("100");
    expect(requests[0]?.searchParams.getAll("environment")).toEqual(["production"]);
    expect(page.incidents.map((row) => row.id)).toEqual(["101"]);
    expect(JSON.stringify(page)).not.toContain("PRIVATE_CONTENT_SENTINEL");
    expect(JSON.stringify(page)).not.toContain("private@example.test");
  });

  it("keeps resolved issues out of the open inbox even with an edited query", async () => {
    const requests: URL[] = [];

    const client = new SentryClient("https://de.sentry.io", "synthetic", async (input) => {
      requests.push(new URL(String(input)));

      return Response.json([sentryIssue(), { ...sentryIssue("102"), status: "resolved" }]);
    });

    const page = await client.page({ ...route(), query: "level:error" }, null, null);
    expect(requests[0]?.searchParams.get("query")).toContain("is:unresolved");
    expect(page.incidents.map((value) => value.id)).toEqual(["101"]);
  });

  it("uses only the cursor from a same-origin next link", async () => {
    const client = new SentryClient("https://de.sentry.io", "synthetic", async () =>
      Response.json([sentryIssue()], {
        headers: {
          link: '<https://de.sentry.io/api/0/organizations/acme/issues/?cursor=0%3A100%3A0>; rel="next"; results="true"',
        },
      }),
    );

    expect((await client.page(route(), null, null)).nextCursor).toBe("0:100:0");
  });

  it("rejects cross-origin pagination rather than forwarding a credential", async () => {
    const client = new SentryClient("https://de.sentry.io", "synthetic", async () =>
      Response.json([], {
        headers: { link: '<https://other.example/issues/?cursor=1>; rel="next"; results="true"' },
      }),
    );

    await expect(client.page(route(), null, null)).rejects.toMatchObject({
      code: "unsafe-pagination",
    });
  });

  it.each([401, 403])("keeps denied access visible for HTTP %i", async (status) => {
    const client = new SentryClient(
      "https://de.sentry.io",
      "synthetic",
      async () => new Response("sensitive failure", { status }),
    );

    await expect(client.page(route(), null, null)).rejects.toMatchObject({ code: "access-denied" });
  });

  it("preserves the provider reset on rate limiting", async () => {
    const client = new SentryClient(
      "https://de.sentry.io",
      "synthetic",
      async () =>
        new Response("", { status: 429, headers: { "x-sentry-rate-limit-reset": "1800000000" } }),
    );

    await expect(client.page(route(), null, null)).rejects.toMatchObject({
      code: "rate-limited",
      retryAt: 1800000000000,
    });
  });

  it.each([new Response("private", { status: 500 }), Response.json({ unexpected: true })])(
    "does not disguise invalid scans as an empty result",
    async (response) => {
      const client = new SentryClient("https://de.sentry.io", "synthetic", async () =>
        response.clone(),
      );

      await expect(client.page(route(), null, null)).rejects.toBeInstanceOf(SentryFailure);
    },
  );
});

describe("Sentry workflow mutations", () => {
  it("resolves only a verified in-route issue and reads its status back", async () => {
    const methods: string[] = [];
    let resolved = false;

    const client = new SentryClient("https://de.sentry.io", "synthetic", async (input, init) => {
      expect(new URL(String(input)).pathname).toBe("/api/0/organizations/acme/issues/101/");
      methods.push(init?.method ?? "GET");

      if (init?.method === "PUT") {
        expect(JSON.parse(String(init.body))).toEqual({ status: "resolved" });
        resolved = true;

        return Response.json({});
      }

      return Response.json({ ...sentryIssue(), status: resolved ? "resolved" : "unresolved" });
    });

    await client.resolve(route(), "101");
    await client.resolve(route(), "101");
    expect(methods).toEqual(["GET", "PUT", "GET", "GET"]);
  });

  it("reconciles a lost resolution response without issuing the mutation twice", async () => {
    let resolved = false;
    let mutations = 0;

    const client = new SentryClient("https://de.sentry.io", "synthetic", async (_input, init) => {
      if (init?.method === "PUT") {
        mutations++;
        resolved = true;
        throw new Error("response lost");
      }

      return Response.json({ ...sentryIssue(), status: resolved ? "resolved" : "unresolved" });
    });

    await client.resolve(route(), "101");
    expect(mutations).toBe(1);
  });

  it("refuses mutations of a project outside the selected route", async () => {
    let requests = 0;

    const client = new SentryClient("https://de.sentry.io", "synthetic", async () => {
      requests++;

      return Response.json({ ...sentryIssue(), project: { id: "999" } });
    });

    await expect(client.resolve(route(), "101")).rejects.toMatchObject({
      code: "issue-outside-route",
    });
    await expect(client.note(route(), "101", "Rationale", "run:1")).rejects.toMatchObject({
      code: "issue-outside-route",
    });
    expect(requests).toBe(2);
  });

  it("deduplicates a rationale note after a lost response and another invocation", async () => {
    let stored = "";
    let mutations = 0;

    const client = new SentryClient("https://de.sentry.io", "synthetic", async (input, init) => {
      const url = new URL(String(input));

      if (init?.method === "POST") {
        expect(url.pathname).toBe("/api/0/organizations/acme/issues/101/comments/");
        stored = JSON.parse(String(init.body)).text;
        mutations++;
        throw new Error("response lost");
      }

      if (url.pathname.endsWith("activities/"))
        return Response.json({
          activity: stored ? [{ type: "note", data: { text: stored } }] : [],
        });

      if (url.pathname.endsWith("comments/")) return Response.json([]);

      return Response.json(sentryIssue());
    });

    await client.note(route(), "101", "Cannot yet distinguish the two causes.", "run:1");
    await client.note(route(), "101", "Cannot yet distinguish the two causes.", "run:1");
    expect(mutations).toBe(1);
  });

  it("finds older note markers through safe comment pagination", async () => {
    const requests: URL[] = [];

    const client = new SentryClient("https://de.sentry.io", "synthetic", async (input, init) => {
      const url = new URL(String(input));
      requests.push(url);
      expect(init?.method).toBeUndefined();

      if (url.pathname.endsWith("activities/")) return Response.json({ activity: [] });

      if (url.pathname.endsWith("comments/")) {
        if (url.searchParams.has("cursor"))
          return Response.json([{ type: "note", data: { text: "Reason\n\n[omnyo:run:1]" } }]);

        return Response.json([], {
          headers: {
            link: '<https://de.sentry.io/api/0/organizations/acme/issues/101/comments/?cursor=next>; rel="next"; results="true"',
          },
        });
      }

      return Response.json(sentryIssue());
    });

    await client.note(route(), "101", "Reason", "run:1");
    expect(requests.filter((url) => url.pathname.endsWith("comments/"))).toHaveLength(2);
  });

  it("keeps unconfirmed mutations visible and rejects invalid identifiers before requests", async () => {
    let mutations = 0;

    const client = new SentryClient("https://de.sentry.io", "synthetic", async (_input, init) => {
      if (init?.method === "PUT") {
        mutations++;

        return Response.json({});
      }

      return Response.json(sentryIssue());
    });

    await expect(client.resolve(route(), "101")).rejects.toMatchObject({
      code: "resolution-not-confirmed",
    });
    await expect(client.resolve(route(), "../other")).rejects.toMatchObject({
      code: "invalid-issue",
    });
    await expect(client.note(route(), "101", "Reason", "invalid\nmarker")).rejects.toMatchObject({
      code: "invalid-note",
    });
    expect(mutations).toBe(1);
  });
});

describe("All-environment routes", () => {
  it("omits environment filtering only for the explicit wildcard", async () => {
    const requests: URL[] = [];

    const client = new SentryClient("https://de.sentry.io", "synthetic", async (input) => {
      requests.push(new URL(String(input)));

      return Response.json([]);
    });

    await client.page({ ...route(), environment: "*" }, null, null);
    await client.page(route(), null, null);
    expect(requests[0]?.searchParams.has("environment")).toBe(false);
    expect(requests[1]?.searchParams.getAll("environment")).toEqual(["production"]);
  });
});
