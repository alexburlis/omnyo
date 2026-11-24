// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  highlightCommand,
  structuredOutputLanguage,
} from "./TimelineCodeBlock";
import { TerminalOutputBlock } from "./TerminalOutputBlock";

afterEach(cleanup);

describe("highlighted tool details", () => {
  it("highlights a Python heredoc without changing text or injecting HTML", () => {
    const command =
      "$ python3 - <<'PY'\nfrom pathlib import Path\nprint('<img src=x onerror=alert(1)>')\nPY";

    const element = document.createElement("div");
    element.innerHTML = highlightCommand(command);
    expect(element.textContent).toBe(command);
    expect(element.querySelector("img")).toBeNull();
    expect(element.querySelectorAll("span").length).toBeGreaterThan(3);
  });

  it("only classifies complete structured JSON as JSON", () => {
    expect(structuredOutputLanguage('{"ok":true}')).toBe("json");
    expect(structuredOutputLanguage("[1,2]")).toBe("json");
    expect(structuredOutputLanguage("[running] build started")).toBeNull();
    expect(structuredOutputLanguage('{"ok":')).toBeNull();
  });

  it("keeps the full command accessible and stops the running cue on completion", () => {
    const commandLine =
      "$ python3 - <<'PY'\n" + "print('hello')\n".repeat(10) + "PY";

    const props = {
      commandLine,
      metadataLines: [],
      output: "hello",
      exitCode: null,
      streaming: true,
    };

    const view = render(<TerminalOutputBlock {...props} />);
    expect(screen.getByRole("status", { name: "Running" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy command" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy output" })).toBeTruthy();
    const expand = screen.getByRole("button", { name: "Show full command" });
    fireEvent.click(expand);
    expect(expand.getAttribute("aria-expanded")).toBe("true");
    expect(view.container.querySelector("code")?.textContent).toBe(commandLine);
    view.rerender(
      <TerminalOutputBlock {...props} streaming={false} exitCode={0} />,
    );
    expect(screen.queryByRole("status", { name: "Running" })).toBeNull();
    expect(screen.getByText("exit code 0")).toBeTruthy();
  });

  it("preserves ANSI output and keeps HTML inert", () => {
    const view = render(
      <TerminalOutputBlock
        commandLine="$ test"
        metadataLines={[]}
        output={"\u001b[31mFailed\u001b[0m <script>alert(1)</script>"}
        streaming={false}
        exitCode={1}
      />,
    );

    expect(view.container.querySelector("script")).toBeNull();
    expect(view.container.textContent).toContain("<script>alert(1)</script>");
    expect(view.container.querySelector('[style*="--ansi-1"]')).toBeTruthy();
  });
});
