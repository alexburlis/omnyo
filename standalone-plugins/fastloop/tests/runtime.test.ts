import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { HostRuntime } from "../runtime.js";

it("materializes the pinned engine with an explicit Node 24 and refuses altered files", async () => {
  const root = await mkdtemp(join(tmpdir(), "fastloop-adapter-runtime-"));

  try {
    const versions = join(homedir(), ".nvm/versions/node");
    const candidates = (await readdir(versions)).filter((name) => name.startsWith("v24.")).sort();
    const selected = candidates.at(-1);

    if (!selected) throw new Error("This runtime qualification requires an installed Node 24.");
    const nodeExecutable = join(versions, selected, "bin/node");
    const runtime = new HostRuntime(root);
    await expect(
      runtime.setup({ nodeExecutable: process.execPath }, AbortSignal.timeout(2000)),
    ).rejects.toThrow();
    expect((await runtime.status()).materialized).toBe(false);
    const prepared = await runtime.setup({ nodeExecutable }, AbortSignal.timeout(10000));
    expect(prepared.adapterNode.startsWith("22.")).toBe(true);
    expect(prepared.node24.startsWith("24.")).toBe(true);
    expect(prepared.nativeInstalled).toBe(false);
    await expect(runtime.assertMaterialized()).resolves.toBeUndefined();
    const project = join(root, "workspace");
    await mkdir(join(project, ".fastloop"), { recursive: true });
    await writeFile(
      join(project, ".fastloop/config.json"),
      JSON.stringify({ allowedOrigins: ["http://127.0.0.1:4173"] }),
    );
    const doctor = await runtime.doctor(project, {}, AbortSignal.timeout(3000));
    expect(doctor.engine.nativeBinaryPresent).toBe(false);
    expect(doctor.engine.providerConfigured).toBe(false);
    expect(doctor.engine.plannerConfigured).toBe(false);
    expect(doctor.serviceProbe).toBeNull();
    const manifest = join(runtime.packageRoot, "runtime-manifest.json");
    await writeFile(manifest, Buffer.concat([await readFile(manifest), Buffer.from(" ")]));
    await expect(runtime.assertMaterialized()).rejects.toThrow("RUNTIME_MATERIALIZATION_ALTERED");
    expect((await runtime.status()).materialized).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 12000);
