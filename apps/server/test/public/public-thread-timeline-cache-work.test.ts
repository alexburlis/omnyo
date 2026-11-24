import { expect, it, vi } from "vitest";
import { seedThreadFixture } from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

it("reads the timeline high-water mark once for a cached latest page", async () => {
  await withTestHarness(async (harness) => {
    const { thread } = seedThreadFixture(harness);
    const url = `/api/v1/threads/${thread.id}/timeline`;
    const warm = await harness.app.request(url);
    expect(warm.status).toBe(200);
    const expected = await warm.json();
    const client = harness.deps.db.$client;
    const prepare = client.prepare.bind(client);
    let reads = 0;
    const statements = new WeakSet<object>();
    const restoreStatements: Array<() => void> = [];

    const watched = vi.spyOn(client, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);

      if (
        /WITH requested\(thread_id\)/.test(sql) &&
        !statements.has(statement)
      ) {
        statements.add(statement);
        const all = statement.all.bind(statement);

        const watchedAll = vi
          .spyOn(statement, "all")
          .mockImplementation((...parameters) => {
            reads += 1;

            return all(...parameters);
          });

        restoreStatements.push(() => watchedAll.mockRestore());
      }

      return statement;
    });

    try {
      const cached = await harness.app.request(url);
      expect(cached.status, await cached.clone().text()).toBe(200);
      expect(await cached.json()).toEqual(expected);
      expect(reads).toBe(1);
    } finally {
      watched.mockRestore();

      for (const restore of restoreStatements) restore();
    }
  });
});
