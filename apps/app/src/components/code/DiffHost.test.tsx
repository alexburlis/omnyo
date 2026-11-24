// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createStore, getDefaultStore, Provider as JotaiProvider } from "jotai";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ExperimentalDiffFullFileContents,
  PluginDiffRendererProps,
} from "@omnyo/plugin-sdk";
import { defaultResolvedCodeTheme } from "@omnyo/domain";
import { applyResolvedCodeTheme } from "@/lib/code-theme";
import {
  resetPluginSlotStoreForTest,
  setPluginSlotRegistrations,
} from "@/lib/plugin-slots";
import { resetAllCrashedPluginSlotsForTest } from "@/components/plugin/PluginSlotMount";
import { parseGitDiffFiles } from "@/components/git-diff/git-diff-parsing";
import { PluginDiff } from "@/components/plugin/PluginDiff";
import {
  AUTOMATIC_REPLACEMENT_PROVIDER,
  BUILT_IN_REPLACEMENT_PROVIDER,
  replacementProviderKey,
} from "@/lib/plugin-replacement-preference";
import { diffRendererProviderAtom } from "./codeRendererProvider";
import { DiffHost } from "./DiffHost";
import { makePluginRegistrationSet } from "@/test/fixtures/plugins";

const omnyoDiff = vi.hoisted(() => ({
  renderFails: false,
  lastProps: null as Record<string, unknown> | null,
}));

vi.mock("./OmnyoDiff", async () => {
  const React = await import("react");

  return {
    default: (props: Record<string, unknown>) => {
      if (omnyoDiff.renderFails) throw new Error("renderer exploded");
      omnyoDiff.lastProps = props;

      return React.createElement(
        "div",
        { "data-testid": "omnyo-diff" },
        `omnyo diff ${String(props.view)}/${String(props.overflow)}`,
      );
    },
  };
});

const PATCH = [
  "diff --git a/src/app.ts b/src/app.ts",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,3 +1,3 @@",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  " const c = 4;",
  "",
].join("\n");

const FULL_FILE_CONTENTS = {
  old: {
    path: "src/app.ts",
    content: [
      "const a = 1;",
      "const b = 2;",
      "const c = 4;",
      "const oldTail = true;",
      "",
    ].join("\n"),
  },
  new: {
    path: "src/app.ts",
    content: [
      "const a = 1;",
      "const b = 3;",
      "const c = 4;",
      "const newTail = true;",
      "",
    ].join("\n"),
  },
} satisfies ExperimentalDiffFullFileContents;

function parseFixture() {
  const file = parseGitDiffFiles(PATCH)[0];

  if (file === undefined) throw new Error("fixture patch did not parse");

  return file;
}

const receivedProps: PluginDiffRendererProps[] = [];

function registerDiffRenderer(
  component: (props: PluginDiffRendererProps) => React.ReactNode,
) {
  setPluginSlotRegistrations(
    "demo",
    makePluginRegistrationSet({
      diffRenderers: [{ id: "diffs", title: "Demo diffs", component }],
    }),
  );
}

beforeEach(() => {
  window.localStorage.clear();
  getDefaultStore().set(
    diffRendererProviderAtom,
    AUTOMATIC_REPLACEMENT_PROVIDER,
  );
  omnyoDiff.renderFails = false;
  omnyoDiff.lastProps = null;
  receivedProps.length = 0;
  resetPluginSlotStoreForTest();
  applyResolvedCodeTheme(defaultResolvedCodeTheme);
});

afterEach(() => {
  cleanup();
  resetAllCrashedPluginSlotsForTest();
  resetPluginSlotStoreForTest();
  vi.restoreAllMocks();
});

describe("DiffHost", () => {
  it("skips Omnyo's renderer and passes full-file contents when a replacement never delegates", async () => {
    registerDiffRenderer((props) => {
      receivedProps.push(props);

      return <div data-testid="plugin-diff">plugin diff</div>;
    });

    render(
      <DiffHost
        file={parseFixture()}
        patchText={PATCH}
        fullFileContents={FULL_FILE_CONTENTS}
        view="split"
      />,
    );

    expect(await screen.findByTestId("plugin-diff")).toBeDefined();
    await act(async () => {
      await Promise.resolve();
    });
    expect(omnyoDiff.lastProps).toBeNull();
    expect(receivedProps.at(-1)?.experimental_fullFileContents).toBe(
      FULL_FILE_CONTENTS,
    );
  });

  it("hands the replacement resolved semantic props, not Omnyo's host-only inputs", async () => {
    registerDiffRenderer((props) => {
      receivedProps.push(props);

      return <div data-testid="plugin-diff">plugin diff</div>;
    });

    render(
      <DiffHost
        file={parseFixture()}
        patchText={PATCH}
        fullFileContents={FULL_FILE_CONTENTS}
        view="split"
        overflow="wrap"
        showLineNumbers={false}
        onSelectionAddToChat={() => {}}
      />,
    );

    await screen.findByTestId("plugin-diff");
    const props = receivedProps.at(-1);
    expect(props?.patch).toBe(PATCH);
    expect(props?.path).toBe("src/app.ts");
    expect(props?.view).toBe("split");
    expect(props?.overflow).toBe("wrap");
    expect(props?.showLineNumbers).toBe(false);
    expect(props?.experimental_fullFileContents).toBe(FULL_FILE_CONTENTS);
    expect(Object.keys(props ?? {})).not.toContain("onSelectionAddToChat");
    expect(Object.keys(props ?? {})).not.toContain("file");
  });

  it("reconstructs a complete single-file patch when the caller has no patch text", async () => {
    registerDiffRenderer((props) => {
      receivedProps.push(props);

      return <div data-testid="plugin-diff">plugin diff</div>;
    });

    render(<DiffHost file={parseFixture()} fullFileContents={null} />);

    await screen.findByTestId("plugin-diff");
    const patch = receivedProps.at(-1)?.patch ?? "";
    expect(patch).toContain("diff --git a/src/app.ts b/src/app.ts");
    expect(patch).toContain("--- a/src/app.ts");
    expect(patch).toContain("+++ b/src/app.ts");
    expect(patch).toContain("-const b = 2;");
    expect(patch).toContain("+const b = 3;");
    const reparsed = parseGitDiffFiles(patch)[0];
    expect(reparsed?.name).toBe("src/app.ts");
    expect(reparsed?.hunks).toHaveLength(1);
  });

  it("loads Omnyo's renderer only when the replacement delegates", async () => {
    registerDiffRenderer(({ path, Original }) =>
      path.endsWith(".ts") ? <Original /> : <div>plugin diff</div>,
    );

    render(
      <DiffHost
        file={parseFixture()}
        patchText={PATCH}
        fullFileContents={null}
      />,
    );

    expect(await screen.findByTestId("omnyo-diff")).toBeDefined();
    expect(omnyoDiff.lastProps?.file).toBeDefined();
  });

  it("honours a pin to Omnyo's renderer without disabling the plugin", async () => {
    registerDiffRenderer((props) => {
      receivedProps.push(props);

      return <div data-testid="plugin-diff">plugin diff</div>;
    });
    const store = createStore();
    store.set(diffRendererProviderAtom, BUILT_IN_REPLACEMENT_PROVIDER);

    render(
      <JotaiProvider store={store}>
        <DiffHost
          file={parseFixture()}
          patchText={PATCH}
          fullFileContents={null}
        />
      </JotaiProvider>,
    );

    expect(await screen.findByTestId("omnyo-diff")).toBeDefined();
    expect(receivedProps).toHaveLength(0);
  });

  it("keeps a pinned provider selected once another plugin sorts ahead of it", async () => {
    registerDiffRenderer((props) => {
      receivedProps.push(props);

      return <div data-testid="plugin-diff">first plugin</div>;
    });
    setPluginSlotRegistrations(
      "aardvark",
      makePluginRegistrationSet({
        diffRenderers: [
          {
            id: "diffs",
            title: "Aardvark diffs",
            component: () => <div data-testid="aardvark-diff">aardvark</div>,
          },
        ],
      }),
    );
    const store = createStore();
    store.set(
      diffRendererProviderAtom,
      replacementProviderKey({ pluginId: "demo", id: "diffs" }),
    );

    render(
      <JotaiProvider store={store}>
        <DiffHost
          file={parseFixture()}
          patchText={PATCH}
          fullFileContents={null}
        />
      </JotaiProvider>,
    );

    expect(await screen.findByTestId("plugin-diff")).toBeDefined();
    expect(screen.queryByTestId("aardvark-diff")).toBeNull();
  });

  it("contains a failing Omnyo renderer inside a delegating replacement without disabling the plugin", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    omnyoDiff.renderFails = true;
    registerDiffRenderer(({ Original }) => (
      <section aria-label="Plugin chrome">
        <Original />
      </section>
    ));

    render(
      <DiffHost
        file={parseFixture()}
        patchText={PATCH}
        fullFileContents={null}
      />,
    );

    const alert = await screen.findByRole("alert");
    expect(
      screen.getByRole("region", { name: "Plugin chrome" }).contains(alert),
    ).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    omnyoDiff.renderFails = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByTestId("omnyo-diff")).toBeDefined();
  });

  it("uses Omnyo's renderer with resolved presentation defaults when nothing is registered", async () => {
    render(<DiffHost file={parseFixture()} fullFileContents={null} />);

    await screen.findByTestId("omnyo-diff");
    expect(omnyoDiff.lastProps?.view).toBe("unified");
    expect(omnyoDiff.lastProps?.overflow).toBe("scroll");
    expect(omnyoDiff.lastProps?.showLineNumbers).toBe(true);
  });
});

describe("experimental_Diff", () => {
  it("shares the replacement with Omnyo's own surfaces", async () => {
    registerDiffRenderer((props) => {
      receivedProps.push(props);

      return <div data-testid="plugin-diff">plugin diff</div>;
    });

    render(<PluginDiff patch={PATCH} path="src/app.ts" />);

    await screen.findByTestId("plugin-diff");
    expect(receivedProps.at(-1)?.path).toBe("src/app.ts");
    expect(receivedProps.at(-1)?.experimental_fullFileContents).toBeNull();
    expect(omnyoDiff.lastProps).toBeNull();
  });

  it("completes a header-less patch before handing it to a replacement", async () => {
    registerDiffRenderer((props) => {
      receivedProps.push(props);

      return <div data-testid="plugin-diff">plugin diff</div>;
    });

    render(
      <PluginDiff
        patch={"@@ -1,2 +1,2 @@\r\n-const b = 2;\r\n+const b = 3;"}
        path="src/app.ts"
      />,
    );

    await screen.findByTestId("plugin-diff");
    const patch = receivedProps.at(-1)?.patch ?? "";
    expect(patch.startsWith("diff --git a/src/app.ts b/src/app.ts\n")).toBe(
      true,
    );
    expect(patch).not.toContain("\r");
  });

  it("defers complete-file enrichment to Omnyo's lazy renderer", async () => {
    render(
      <PluginDiff
        patch={PATCH}
        path="src/app.ts"
        experimental_fullFileContents={FULL_FILE_CONTENTS}
      />,
    );

    await screen.findByTestId("omnyo-diff");

    const file = omnyoDiff.lastProps?.file as ReturnType<
      typeof parseFixture
    > | null;

    expect(file?.isPartial).toBe(true);
    expect(omnyoDiff.lastProps?.patchText).toBe(PATCH);
    expect(omnyoDiff.lastProps?.fullFileContents).toBe(FULL_FILE_CONTENTS);
    expect(omnyoDiff.lastProps).not.toHaveProperty("expansionLineCount");
  });

  it("degrades to plain text instead of an empty diff when the patch will not parse", () => {
    render(<PluginDiff patch="not a patch at all" path="notes.txt" />);

    expect(screen.getByText("not a patch at all")).toBeDefined();
    expect(screen.queryByTestId("omnyo-diff")).toBeNull();
    expect(omnyoDiff.lastProps).toBeNull();
  });
});
