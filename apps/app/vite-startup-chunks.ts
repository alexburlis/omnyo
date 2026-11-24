import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";
import { z } from "zod";

const STARTUP_ROOTS = [
  { name: "shell", path: "/src/app-entry.tsx" },
  { name: "workspace", path: "/src/views/SplitWorkspaceRoute.tsx" },
  { name: "thread", path: "/src/views/thread-detail/ThreadDetailView.tsx" },
  { name: "compose", path: "/src/views/RootComposeView.tsx" },
  { name: "plugins", path: "/src/lib/plugin-frontend.ts" },
];

export function startupChunks(): Plugin {
  const memberships = new Map<string, number>();
  const excludedPackages = new Set<string>();

  return {
    name: "omnyo:startup-chunks",
    apply: "build",
    configResolved(config) {
      const budget = JSON.parse(
        readFileSync(resolve(config.root, "bundle-budget.json"), "utf8"),
      );

      const policy = z
        .object({ onDemandPackages: z.record(z.string(), z.string()) })
        .parse(budget);

      for (const name of Object.keys(policy.onDemandPackages))
        excludedPackages.add(name);
    },
    buildStart() {
      memberships.clear();
    },
    buildEnd(error) {
      if (error) return;
      const modules = [...this.getModuleIds()];

      for (const [index, root] of STARTUP_ROOTS.entries()) {
        const rootId = modules.find((id) =>
          id.replaceAll("\\", "/").endsWith(root.path),
        );

        if (rootId === undefined) continue;
        const mask = 1 << index;
        const pending = [rootId];

        while (pending.length > 0) {
          const id = pending.pop();

          if (id === undefined) continue;
          const membership = memberships.get(id) ?? 0;

          if ((membership & mask) !== 0) continue;
          const info = this.getModuleInfo(id);

          if (info === null) continue;
          memberships.set(id, membership | mask);
          pending.push(...info.importedIds);
        }
      }
    },
    outputOptions(options) {
      return {
        ...options,
        strictExecutionOrder: true,
        codeSplitting: {
          groups: [
            {
              name: "boot-vendor",
              test: /node_modules/,
              tags: ["$initial"],
              priority: 3,
            },
            {
              name: "boot-app",
              tags: ["$initial"],
              priority: 2,
            },
            {
              name(id) {
                const membership = memberships.get(id);

                if (membership === undefined) return null;
                const path = id.replaceAll("\\", "/");

                const packageStart = path.lastIndexOf("/node_modules/");

                const packagePath =
                  packageStart < 0 ? "" : path.slice(packageStart + 14);

                const parts = packagePath.split("/");

                const packageName = parts[0]?.startsWith("@")
                  ? parts.slice(0, 2).join("/")
                  : parts[0];

                if (packageName && excludedPackages.has(packageName))
                  return null;

                return `startup-${STARTUP_ROOTS.filter(
                  (_, index) => (membership & (1 << index)) !== 0,
                )
                  .map((root) => root.name)
                  .join("-")}`;
              },
              includeDependenciesRecursively: false,
              priority: 1,
            },
          ],
        },
      };
    },
  };
}
