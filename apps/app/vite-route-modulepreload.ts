import type { Plugin, Rollup } from "vite";
import {
  isWorkspaceRoutePath,
  PROJECTLESS_THREAD_DETAIL_ROUTE_PATH,
  ROUTE_PATTERNS,
  THREAD_DETAIL_ROUTE_PATH,
} from "@omnyo/client-core/route-paths";

function staticClosure(
  bundle: Rollup.OutputBundle,
  fileName: string,
): Set<string> {
  const files = new Set<string>();

  const visit = (name: string) => {
    if (files.has(name)) return;
    files.add(name);
    const chunk = bundle[name];

    if (chunk?.type === "chunk") chunk.imports.forEach(visit);
  };

  visit(fileName);

  return files;
}

export function routeModulePreload(
  modulePath: string,
  additionalModules: readonly string[] = [],
): Plugin {
  let base = "/";

  return {
    name: "omnyo:route-modulepreload",
    apply: "build",
    configResolved(config) {
      base = config.base;
    },
    transformIndexHtml: {
      order: "post",
      handler(_html, { bundle }) {
        if (bundle === undefined) return [];

        const chunks = Object.values(bundle).filter(
          (output): output is Rollup.OutputChunk => output.type === "chunk",
        );

        const routeChunk = (path: string) => {
          const chunk = chunks.find((candidate) =>
            Object.keys(candidate.modules).some((module) =>
              module.endsWith(`/${path}`),
            ),
          );

          if (chunk === undefined)
            throw new Error(`Missing route chunk for ${path}`);

          return chunk;
        };

        const routes = [modulePath, ...additionalModules].map(routeChunk);

        const entry = chunks.find((chunk) => chunk.isEntry);

        const boot =
          entry === undefined
            ? new Set<string>()
            : staticClosure(bundle, entry.fileName);

        const routeFiles = new Set(
          routes.flatMap((route) => [...staticClosure(bundle, route.fileName)]),
        );

        const preloadUrls = [...routeFiles].reduce<string[]>((urls, file) => {
          if (!boot.has(file)) urls.push(`${base}${file}`);

          return urls;
        }, []);

        const threadUrls = [
          ...staticClosure(
            bundle,
            routeChunk("src/views/thread-detail/ThreadDetailView.tsx").fileName,
          ),
        ]
          .filter((file) => !boot.has(file) && !routeFiles.has(file))
          .map((file) => `${base}${file}`);

        const threadPaths = [
          PROJECTLESS_THREAD_DETAIL_ROUTE_PATH,
          THREAD_DETAIL_ROUTE_PATH,
        ];

        const threadPattern = `^(?:${threadPaths
          .map((path) => path.replace(/:[^/]+/g, "[^/]+"))
          .join("|")})/?$`;

        const source = [
          "(() => {",
          `  const isWorkspaceRoutePath = (${isWorkspaceRoutePath.toString()});`,
          `  if (!isWorkspaceRoutePath(window.location.pathname, ${JSON.stringify(ROUTE_PATTERNS)})) return;`,
          `  const urls = ${JSON.stringify(preloadUrls)};`,
          `  if (new RegExp(${JSON.stringify(threadPattern)}, "i").test(window.location.pathname)) urls.push(...${JSON.stringify(threadUrls)});`,
          "  for (const href of urls) {",
          '    const link = document.createElement("link");',
          '    link.rel = "modulepreload";',
          '    link.crossOrigin = "";',
          "    link.href = href;",
          "    document.head.appendChild(link);",
          "  }",
          "})();",
        ].join("\n");

        return [
          {
            tag: "script",
            children: source,
            injectTo: "head" as const,
          },
        ];
      },
    },
  };
}
