import assert from "node:assert/strict";
import { createRequire, registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { catalog, response, skill, workflow } from "./marketplace-fixture.mjs";

const [testingLibraryPath, jsdomPath] = process.argv.slice(2);

assert.ok(
  testingLibraryPath && jsdomPath,
  "Pass installed @testing-library/react and jsdom module paths.",
);

const require = createRequire(import.meta.url);

const sharedReact = new Map(
  [
    "react",
    "react/jsx-runtime",
    "react/jsx-dev-runtime",
    "react-dom",
    "react-dom/client",
    "react-dom/test-utils",
  ].map((specifier) => [specifier, pathToFileURL(require.resolve(specifier)).href]),
);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@testing-library/react")
      return { url: pathToFileURL(testingLibraryPath).href, shortCircuit: true };
    const shared = sharedReact.get(specifier);

    if (shared) return { url: shared, shortCircuit: true };

    return nextResolve(specifier, context);
  },
});

const { JSDOM } = await import(pathToFileURL(jsdomPath).href);

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://app.example.test/",
});

for (const name of [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLButtonElement",
  "Node",
  "MutationObserver",
  "getComputedStyle",
])
  Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });

window.HTMLElement.prototype.scrollIntoView = () => {};

globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);

globalThis.cancelAnimationFrame = clearTimeout;

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { loadPluginApp, renderSlot } = await import("@omnyo/plugin-sdk/testing/app");

const { fireEvent } = await import(pathToFileURL(testingLibraryPath).href);

globalThis.__omnyoPluginRuntime = {
  jsxRuntime: await import("react/jsx-runtime"),
  sonner: await import("sonner"),
};

const app = await loadPluginApp(() => import("../dist/app.js"));

const panel = app.navPanels.find((item) => item.path === "browse");

assert.ok(panel, "The actual built plugin registers Skills.");

assert.deepEqual(
  app.navPanels.map(({ title }) => title),
  ["Skills"],
);

function render(value = response, enabled = true, handler = () => value) {
  dom.window.localStorage.clear();

  const slot = renderSlot(
    panel,
    { subPath: "" },
    {
      rpc: {
        marketplaceGet: handler,
        catalogGet: () => ({
          generation: "a".repeat(64),
          entries: [
            {
              id: response.reviewedSkills[skill.slug],
              name: skill.slug,
              publisher: skill.publisher,
              description: skill.summary,
              sourceUrl: skill.sourceUrl,
              license: skill.license,
              useOnce: false,
            },
          ],
        }),
      },
      sdk: {
        plugins: {
          list: async () => ({ plugins: [{ id: "workspace-github", enabled, hasSettings: true }] }),
        },
        projects: { list: async () => [] },
      },
    },
  );

  fireEvent.click(slot.getByRole("button", { name: "Marketplace" }));

  return slot;
}

const slot = render();

try {
  await slot.findByText("1 result");
  fireEvent.change(slot.getByLabelText("Type"), { target: { value: "" } });
  await slot.findByText("3 results");
  assert.equal(
    slot.getByRole("link", { name: "Review workflow" }).getAttribute("href"),
    `/plugins/automations/automations/import/${workflow.sha256.slice(0, 32)}`,
  );
  assert.equal(
    slot.getByRole("link", { name: "Configure" }).getAttribute("href"),
    "/settings/plugins/workspace-github",
  );
  fireEvent.change(slot.getByLabelText("Search"), { target: { value: "review writing" } });
  await slot.findByText("1 result");
  assert.equal(slot.queryByText("Weekly Review"), null);
  fireEvent.click(slot.getByRole("button", { name: "Review package" }));
  await slot.findByRole("heading", { name: "Review skill import" });
  assert.ok(slot.getByRole("button", { name: "Review pack" }).disabled);
  assert.equal(
    slot.inspection.rpcCalls.some((call) => call.method === "packConfirm"),
    false,
  );
  assert.equal(
    slot.inspection.sdkCalls.some((call) => /install|update|create|enable/u.test(call.method)),
    false,
  );
} finally {
  slot.lifecycle.unmount();
}

const disabled = render(response, false);

try {
  fireEvent.change(disabled.getByLabelText("Type"), { target: { value: "connector" } });
  await disabled.findByText("Disabled", { exact: false });
  assert.equal(disabled.queryByRole("link", { name: "Configure" }), null);
  assert.ok(disabled.getByRole("link", { name: "View connector" }));
} finally {
  disabled.lifecycle.unmount();
}

let attempt = 0;

const retry = render(response, true, () => {
  if (attempt++ === 0) throw new Error("Catalog unavailable");

  return response;
});

try {
  await retry.findByText("The marketplace could not load.");
  fireEvent.click(retry.getByRole("button", { name: "Retry" }));
  await retry.findByText("1 result");
  assert.equal(attempt, 2);
} finally {
  retry.lifecycle.unmount();
}

const many = render({
  ...response,
  catalog: {
    ...catalog,
    items: Array.from({ length: 50 }, (_, index) => ({
      ...skill,
      slug: `skill-${index}`,
      title: `Skill ${index}`,
      detailPath: `/explore/skills/source/skill-${index}`,
    })),
  },
  reviewedSkills: {},
});

try {
  await many.findByText("50 results");
  assert.equal(many.container.querySelectorAll("article").length, 36);
  fireEvent.click(many.getByRole("button", { name: "Show more" }));
  assert.equal(many.container.querySelectorAll("article").length, 50);
} finally {
  many.lifecycle.unmount();
}

const markdown = "# Example notes\n\nInspect the evidence.\n";

const file = new File([markdown], "example-notes.md", { type: "text/markdown" });

const project = {
  id: "project",
  name: "Test workspace",
  kind: "personal",
  sources: [{ isDefault: true, path: "/work", hostId: "test-host" }],
};

const installed = {
  id: "skill_example",
  name: "example-notes",
  description: "Inspect the evidence.",
  scope: "omnyo-project",
  provider: null,
  filePath: "/work/.omnyo/skills/example-notes/SKILL.md",
  manageable: true,
  pluginId: null,
};

function renderLibrary(subPath = "") {
  return renderSlot(
    panel,
    { subPath },
    {
      rpc: {
        libraryGet: () => ({ revision: 0, collections: [], links: [], prompts: [] }),
        packReview: (input) => ({
          ...input,
          reviewId: "84d391db-e26c-4dbe-94a9-92fbb92478ac",
          digest: "a".repeat(64),
          destination: "available",
          receipt: null,
          workspacePath: "/work",
          pack: {
            title: "Example notes",
            description: installed.description,
            publisher: "local",
            version: "1.0.0",
            license: "Unspecified",
            skills: [{ id: installed.name, files: [{ path: "SKILL.md", content: markdown }] }],
            prompts: [],
          },
        }),
      },
      sdk: {
        projects: { list: async () => [project] },
        environments: { list: async () => [] },
        skills: {
          list: async () => ({ skills: [installed] }),
          getContent: async () => ({ content: markdown, revision: "r1" }),
        },
      },
    },
  );
}

for (const input of ["picker", "drop"]) {
  dom.window.localStorage.clear();
  const library = renderLibrary();

  try {
    await library.findByRole("button", { name: /Example Notes/iu });

    if (input === "picker") {
      fireEvent.click(library.getByRole("button", { name: "Import", exact: true }));
      assert.ok(library.getByRole("button", { name: "Choose file" }));
      fireEvent.change(library.getByLabelText("Import Markdown or skill pack"), {
        target: { files: [file] },
      });
    } else {
      fireEvent.drop(library.container.querySelector(".sd-page"), {
        dataTransfer: { types: ["Files"], files: [file] },
      });
    }

    await library.findByRole("button", { name: "Install in Test workspace" });
    const review = library.inspection.rpcCalls.find((call) => call.method === "packReview");
    assert.deepEqual(review.input, {
      projectId: "project",
      environmentId: null,
      source: { kind: "markdown", filename: file.name, text: markdown },
    });
    fireEvent.click(library.getByRole("button", { name: "Cancel" }));
    assert.equal(
      library.inspection.rpcCalls.some((call) => call.method === "packConfirm"),
      false,
    );
    await library.findByRole("heading", { name: "All skills" });
  } finally {
    library.lifecycle.unmount();
  }
}

const library = renderLibrary(`installed/${installed.id}`);

const createObjectURL = URL.createObjectURL;

const revokeObjectURL = URL.revokeObjectURL;

const originalClick = window.HTMLAnchorElement.prototype.click;

let exported;

let filename;

try {
  URL.createObjectURL = (blob) => {
    exported = blob;

    return "blob:skill";
  };

  URL.revokeObjectURL = () => {};

  window.HTMLAnchorElement.prototype.click = function () {
    filename = this.download;
  };

  fireEvent.click(await library.findByRole("button", { name: "Export Markdown" }));
  assert.equal(filename, "example-notes.md");
  assert.equal(await exported.text(), markdown);
} finally {
  URL.createObjectURL = createObjectURL;
  URL.revokeObjectURL = revokeObjectURL;
  window.HTMLAnchorElement.prototype.click = originalClick;
  library.lifecycle.unmount();
}

dom.window.close();

console.log(
  "Built plugin SDK fixture passed: native links, exact review handoff, filtering, pagination, unavailable/retry, and disabled connector state; no installation or execution.",
);
