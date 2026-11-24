import { describe, expect, it } from "vitest";
import {
  renderTemplate,
  type TemplateId,
  type TemplateVariables,
} from "../src/index.js";
import { templateDefinitions } from "../src/generated/templates.generated.js";

describe("@omnyo/templates", () => {
  it("documents project creation machine routing", () => {
    const guide = renderTemplate("omnyoGuideProjects", {});

    expect(guide).toContain("omnyo project create --name");
    expect(guide).toContain("--machine <id-or-name>");
    expect(guide).toContain("--host <id-or-name>");
    expect(guide).toContain("local CLI machine fallback");
  });

  it("documents complete and partial automation execution updates", () => {
    const guide = renderTemplate("omnyoGuideAutomations", {});

    expect(guide).toContain("omnyo automation update <automationId>");
    expect(guide).toContain("Partial updates to an existing");
    expect(guide).toContain("Partial updates to an existing script accept");
    expect(guide).toContain("A new `--script-file` keeps the");
    expect(guide).not.toContain("complete script source");
    expect(guide).toContain("--env-json");
    expect(guide).toContain("--reasoning <level>");
    expect(guide).toContain("--service-tier <tier>");
    expect(guide).toContain("--clear-service-tier");
    expect(guide).toContain("--permission-mode <accept-edits|auto|full>");
    expect(guide).not.toContain("workspace-write|readonly");
  });

  it("documents project-aware thread references", () => {
    const guide = renderTemplate("omnyoGuideThreads", {});

    expect(guide).toContain("@thread:thr_abc123");
    expect(guide).toContain("do not construct thread URLs manually");
  });

  it("renders agent thread messages without inline reply guidance", () => {
    const rendered = renderTemplate("agentThreadMessage", {
      senderThreadId: "thr_sender",
      messageText: "Please check the failing test.",
    });

    expect(rendered).toBe(
      [
        "[Omnyo message from thread:thr_sender]",
        "",
        "Please check the failing test.",
      ].join("\n"),
    );
  });

  it("renders child thread needs-attention messages with blocker summaries", () => {
    const rendered = renderTemplate("systemMessageChildThreadNeedsAttention", {
      blockerSummary: [
        "Blocked on command approval:",
        "Command: git push",
      ].join("\n"),
      threadMention: "@thread:thr_child",
    });

    expect(rendered).toBe(
      [
        "[Omnyo system]",
        "",
        "@thread:thr_child needs help.",
        "Blocked on command approval:",
        "Command: git push",
        "",
        "Review the blocker. If you can resolve it from existing context, reply to the thread with guidance. Otherwise, ask for the missing decision with your own question tool; it reaches the owner, or your parent chat when this chat is a child.",
      ].join("\n"),
    );
  });

  it("renders child thread questions with an exact reply command", () => {
    const rendered = renderTemplate("systemMessageChildThreadQuestion", {
      childThreadId: "thr_child",
      questions: "Required: Which layout?\n- Compact (recommended)\n- Detailed",
      threadMention: "@thread:thr_child",
    });

    expect(rendered).toBe(
      [
        "[Omnyo system]",
        "",
        "@thread:thr_child asks you, not the owner:",
        "",
        "Required: Which layout?",
        "- Compact (recommended)",
        "- Detailed",
        "",
        "Reply with `omnyo thread tell thr_child --mode auto` and your answer when your context and authority cover it. When only the owner can decide, approve or supply something, ask with your own question tool, then relay the answer to the child the same way. The owner does not see this question.",
      ].join("\n"),
    );
  });

  it("renders child thread ownership messages", () => {
    expect(
      renderTemplate("systemMessageThreadOwnershipAssigned", {
        threadMention: "@thread:thr_child",
      }),
    ).toBe(
      [
        "[Omnyo system]",
        "",
        "@thread:thr_child is now a child of this thread.",
      ].join("\n"),
    );
    expect(
      renderTemplate("systemMessageThreadOwnershipRemoved", {
        threadMention: "@thread:thr_child",
      }),
    ).toBe(
      [
        "[Omnyo system]",
        "",
        "@thread:thr_child is no longer a child of this thread.",
      ].join("\n"),
    );
  });

  it("renders all templates without error", () => {
    const templates = templateDefinitions;

    const placeholderVariables: Record<string, Record<string, string>> = {};

    for (const template of templates) {
      const vars: Record<string, string> = {};

      for (const varName of Object.keys(template.variables)) {
        vars[varName] = `__placeholder_${varName}__`;
      }

      placeholderVariables[template.id] = vars;
    }

    for (const template of templates) {
      const vars = placeholderVariables[
        template.id
      ] as TemplateVariables[TemplateId];

      expect(() =>
        renderTemplate(template.id as TemplateId, vars),
      ).not.toThrow();
    }
  });
});
