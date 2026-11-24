import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { lstat, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export async function proveNotifications({
  evidenceDir,
  binding,
  result,
  rpc,
  configure,
  readNotice,
  assertOwnership,
}) {
  const startedAt = Date.now();
  const deadline = startedAt + 10 * 60_000;
  const runId = randomUUID();

  const notice = {
    id: `native-proof:${runId}`,
    title: "Omnyo native proof",
    body: `Candidate notification ${runId}`,
  };

  Object.assign(result, {
    status: "running",
    runId,
    startedAt: new Date(startedAt).toISOString(),
    deadline: new Date(deadline).toISOString(),
    binding,
    notice,
    clickRoute: binding.serverUrl + "/",
    checkpoints: [],
  });

  async function checkpoint(phase, expected, action = async () => {}) {
    await assertOwnership();
    const requestedAt = Date.now();
    assert.ok(
      requestedAt < deadline,
      "Notification proof exceeded ten minutes",
    );
    const requestPath = join(evidenceDir, `notification-${phase}.request.json`);

    const responsePath = join(
      evidenceDir,
      `notification-${phase}.observed.json`,
    );

    const request = {
      schema: 1,
      runId,
      phase,
      binding,
      notice,
      requestedAt,
      deadline,
      expected,
      responsePath,
    };

    await writeFile(`${requestPath}.tmp`, JSON.stringify(request, null, 2), {
      flag: "wx",
      mode: 0o600,
    });
    await rename(`${requestPath}.tmp`, requestPath);
    console.log(JSON.stringify({ nativeNotificationCheckpoint: requestPath }));
    await action();
    const effectCompletedAt = Date.now();
    const effectPath = join(evidenceDir, `notification-${phase}.effect.json`);
    await writeFile(
      `${effectPath}.tmp`,
      JSON.stringify({ runId, phase, effectCompletedAt }),
      { flag: "wx", mode: 0o600 },
    );
    await rename(`${effectPath}.tmp`, effectPath);
    let response;

    while (Date.now() < deadline) {
      try {
        response = JSON.parse(await readFile(responsePath, "utf8"));
        break;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }

      await new Promise((done) => setTimeout(done, 250));
    }

    assert.ok(response, `Native driver timed out during ${phase}`);
    assert.equal(response.schema, 1);
    assert.equal(response.runId, runId);
    assert.equal(response.phase, phase);
    assert.equal(response.status, "observed", `Native driver failed ${phase}`);
    assert.deepEqual(response.binding, binding);
    assert.ok(Number.isSafeInteger(response.observedFrom));
    assert.ok(Number.isSafeInteger(response.observedUntil));
    assert.ok(response.observedFrom >= requestedAt);
    assert.ok(response.observedUntil >= response.observedFrom);
    assert.ok(response.observedUntil >= effectCompletedAt);
    assert.ok(response.observedUntil <= Date.now());
    assert.ok(response.observedUntil <= deadline);

    for (const [key, value] of Object.entries(expected))
      assert.deepEqual(response.observation?.[key], value, `${phase}: ${key}`);

    if (phase.startsWith("duplicate"))
      assert.ok(
        response.observedFrom <= effectCompletedAt &&
          response.observedUntil - effectCompletedAt >= 5_000,
        "Observe each duplicate for at least five seconds",
      );
    assert.ok(
      Array.isArray(response.artifacts) && response.artifacts.length > 0,
    );

    if (phase === "displayed")
      assert.ok(
        response.artifacts.some((artifact) => artifact.kind === "screenshot"),
      );

    if (phase === "clicked")
      assert.ok(
        response.artifacts.some((artifact) =>
          ["accessibility", "window-url"].includes(artifact.kind),
        ),
      );

    for (const artifact of response.artifacts) {
      assert.ok(
        ["screenshot", "accessibility", "window-url"].includes(artifact.kind),
      );
      const path = await realpath(resolve(evidenceDir, artifact.path));
      assert.ok(path.startsWith(`${await realpath(evidenceDir)}/`));
      assert.equal((await lstat(path)).isFile(), true);
      assert.ok((await lstat(path)).size > 0);
      const bytes = await readFile(path);

      if (artifact.kind === "screenshot")
        assert.deepEqual(
          bytes.subarray(0, 8),
          Buffer.from("89504e470d0a1a0a", "hex"),
        );
      assert.equal(
        createHash("sha256").update(bytes).digest("hex"),
        artifact.sha256,
      );
    }

    await assertOwnership();
    result.checkpoints.push({ requestPath, responsePath, ...response });
  }

  async function accepted() {
    while (Date.now() < deadline) {
      const stored = readNotice(notice.id);

      if (stored?.acceptedTargets.length) {
        assert.deepEqual(stored.message, {
          ...notice,
          threadId: null,
          channels: ["web", "desktop"],
        });
        assert.equal(stored.acceptedTargets.length, 1);
        assert.match(stored.acceptedTargets[0], /^desktop:/u);

        const pending = await rpc("notifications.pending", {
          channel: "desktop",
        });

        assert.equal(
          pending.messages.some((item) => item.id === notice.id),
          false,
        );

        return stored;
      }

      await new Promise((done) => setTimeout(done, 250));
    }

    throw new Error("Native notification acceptance timed out");
  }

  try {
    result.settings = await configure();
    await checkpoint("closed", { windowCount: 0 });
    await checkpoint(
      "displayed",
      {
        windowCount: 0,
        notificationId: notice.id,
        title: notice.title,
        body: notice.body,
        displayedCount: 1,
      },
      async () => {
        result.queued = await rpc("notifications.send", notice);
        assert.equal(result.queued.id, notice.id);
        assert.equal(result.queued.durable, true);
        assert.equal(result.queued.duplicate, false);
        assert.ok(["queued", "dispatched"].includes(result.queued.status));
        result.accepted = await accepted();
      },
    );

    async function duplicate(phase, windowCount) {
      await checkpoint(
        phase,
        {
          windowCount,
          notificationId: notice.id,
          redisplayedCount: 0,
          ...(phase === "duplicate-reopened"
            ? { remainingMatchingNotifications: 0 }
            : {}),
        },
        async () => {
          const receipt = await rpc("notifications.send", notice);
          assert.equal(receipt.duplicate, true);
          assert.equal(receipt.status, "dispatched");
          assert.equal(receipt.acceptedTargetCount, 1);
          assert.deepEqual(await accepted(), result.accepted);
          result[phase] = receipt;
        },
      );
    }

    await duplicate("duplicate-closed", 0);
    await checkpoint("clicked", {
      clickedNotificationId: notice.id,
      windowCount: 1,
      windowOrigin: binding.serverUrl,
      windowPathname: "/",
    });
    await duplicate("duplicate-reopened", 1);
    result.persistedAcceptance = await accepted();
    result.status = "passed";
  } catch (error) {
    result.status = "failed";
    result.failure = error.message;
    throw error;
  } finally {
    result.completedAt = new Date().toISOString();
  }
}
