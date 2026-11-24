import "./terminal-demo.css";

import { useId, useRef, useState, type FormEvent } from "react";

const WORKSPACE = "/Users/demo/worktrees/export-csv";

const GIT_STATUS = {
  command: "git status --short",
  output: " M src/invoices/export.ts\n?? src/invoices/export.test.ts",
  tone: "plain",
} as const;

const SAMPLES = [
  { command: "pwd", output: WORKSPACE, tone: "plain" },
  GIT_STATUS,
  {
    command: "pnpm test",
    output: "✓ src/invoices/export.test.ts (4 tests)\n\n4 tests passed",
    tone: "success",
  },
] as const;

export const label =
  "An Omnyo chat stays visible above its composer terminal while Git shows changes in the chat's worktree.";

export function Visual() {
  return (
    <div className="fv fv-terminal" aria-hidden="true">
      <p className="fv-terminal-title">Add CSV export</p>
      <p className="fv-terminal-message">The export is ready to check.</p>
      <div className="fv-terminal-shell">
        <p className="fv-eyebrow">›_ Chat terminal</p>
        <p>
          <span>$</span> {GIT_STATUS.command}
        </p>
        <pre>{GIT_STATUS.output}</pre>
      </div>
    </div>
  );
}

export function Demo() {
  const [shellOpen, setShellOpen] = useState(false);
  const [draft, setDraft] = useState(`!${GIT_STATUS.command}`);
  const [result, setResult] = useState<(typeof SAMPLES)[number] | null>(null);
  const [hint, setHint] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const hintId = useId();

  function run(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const entered = draft.trim();
    const command = entered.startsWith("!") ? entered.slice(1).trim() : entered;
    const sample = SAMPLES.find((entry) => entry.command === command);

    if (!sample || (!shellOpen && !entered.startsWith("!"))) {
      setHint(
        !shellOpen && !entered.startsWith("!")
          ? "Start with ! to run a command from chat."
          : "Try one of the sample commands below.",
      );

      return;
    }

    setResult(sample);
    setShellOpen(true);
    setDraft("");
    setHint("");
  }

  function toggleShell() {
    setShellOpen(!shellOpen);
    setDraft("");
    setHint("");
  }

  function selectCommand(command: string) {
    setDraft(shellOpen ? command : `!${command}`);
    setHint("");
    input.current?.focus();
  }

  return (
    <section className="terminal-demo" aria-labelledby={titleId}>
      <header className="terminal-demo-bar">
        <p id={titleId}>Add CSV export</p>
        <span>Interactive demo</span>
      </header>
      <div className="terminal-demo-chat">
        <p className="terminal-demo-user">Add a CSV export to invoices.</p>
        <p>I’ve added the export and tests in this worktree.</p>
      </div>
      <div className="terminal-demo-composer">
        <div className="terminal-demo-toolbar">
          <p>
            <span aria-hidden="true">{shellOpen ? "›_" : "!"}</span>
            {shellOpen ? "Chat terminal" : "Runs in terminal"}
          </p>
          <button
            className="terminal-demo-switch"
            type="button"
            onClick={toggleShell}
          >
            {shellOpen ? "Back to chat" : "Show terminal"}
          </button>
        </div>
        <div role="status">
          <div className="terminal-demo-shell" hidden={!shellOpen}>
            <p className="terminal-demo-path">{WORKSPACE}</p>
            {result ? (
              <>
                <p className="terminal-demo-line">
                  <span aria-hidden="true">$</span> {result.command}
                </p>
                <pre className={`terminal-demo-output is-${result.tone}`}>
                  {result.output}
                </pre>
              </>
            ) : null}
          </div>
        </div>
        <form className="terminal-demo-form" onSubmit={run}>
          {shellOpen ? <span aria-hidden="true">$</span> : null}
          <input
            ref={input}
            aria-label="Demo command"
            aria-describedby={hint ? hintId : undefined}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            placeholder={
              shellOpen ? "Type a command" : "Type ! followed by a command"
            }
            value={draft}
            onChange={(event) => {
              setDraft(event.currentTarget.value);
              setHint("");
            }}
          />
          <button className="terminal-demo-run" type="submit">
            Run <span aria-hidden="true">↵</span>
          </button>
        </form>
        <p
          id={hintId}
          className="terminal-demo-hint"
          role="status"
          hidden={!hint}
        >
          {hint}
        </p>
      </div>
      <div
        className="terminal-demo-samples"
        role="group"
        aria-label="Sample commands"
      >
        {SAMPLES.map(({ command }) => (
          <button
            key={command}
            type="button"
            onClick={() => selectCommand(command)}
          >
            {shellOpen ? command : `!${command}`}
          </button>
        ))}
      </div>
    </section>
  );
}
