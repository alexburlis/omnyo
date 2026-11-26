export const label =
  "A Codex chat's favorites bar offers Opus 5.5 as a New chat chip. Clicking it hands the work to a new Claude Code chat, which opens with a Continued from banner linking back to the Codex chat.";

function Codex() {
  return (
    <svg className="fv-xh-mark" viewBox="0 0 16 16">
      <ellipse cx="8" cy="8" rx="3.5" ry="6.3" />
      <ellipse cx="8" cy="8" rx="3.5" ry="6.3" transform="rotate(60 8 8)" />
      <ellipse cx="8" cy="8" rx="3.5" ry="6.3" transform="rotate(120 8 8)" />
    </svg>
  );
}

function Claude() {
  return (
    <svg className="fv-xh-mark is-claude" viewBox="0 0 16 16">
      <path d="M8 1.5v13M1.5 8h13M3.4 3.4l9.2 9.2M12.6 3.4l-9.2 9.2" />
    </svg>
  );
}

export function Visual() {
  return (
    <div className="fv fv-codex-gui-handoff" aria-hidden="true">
      <div className="fv-xh-track">
        <section className="fv-xh-pane">
          <header className="fv-xh-bar">
            <Codex />
            <b>Fix date parser</b>
            <small>harbor-ledger · Codex</small>
          </header>
          <div className="fv-xh-thread">
            <p className="fv-xh-say">
              Three of four date formats pass. European dates still fail in
              parseDate.
            </p>
            <p className="fv-xh-tools fv-dim">
              Ran pnpm test date-parser · 1 failed
            </p>
          </div>
          <div className="fv-xh-composer">
            <span className="fv-dim">Ask for a follow-up</span>
            <div className="fv-xh-favs">
              <span className="fv-xh-chip is-on">
                <Codex />
                GPT-5.6 Sol <i>High</i>
              </span>
              <span className="fv-xh-chip is-new">
                <Claude />
                Opus 5.5 <i>xHigh</i>
                <em>New chat</em>
              </span>
            </div>
          </div>
          <svg className="fv-xh-cursor" viewBox="0 0 16 20">
            <path d="M2 1.5v14.2l3.6-3.4 2.3 5.4 2.4-1-2.3-5.3h5z" />
          </svg>
        </section>
        <section className="fv-xh-pane is-next">
          <header className="fv-xh-bar">
            <Claude />
            <b>Fix date parser</b>
            <small>harbor-ledger · Claude Code</small>
          </header>
          <div className="fv-xh-thread">
            <p className="fv-xh-say is-in">
              Picking up from the Codex chat: European dates fail because
              parseDate assumes month first.
            </p>
            <p className="fv-xh-tools fv-dim is-in">
              Reading src/date-parser.ts
            </p>
          </div>
          <div className="fv-xh-composer">
            <p className="fv-xh-banner">
              <svg viewBox="0 0 16 16">
                <path d="M3 4v3.5A2.5 2.5 0 0 0 5.5 10H13M10 7l3 3-3 3" />
              </svg>
              Continued from <u>Fix date parser</u>
              <span className="fv-dim">· Codex</span>
            </p>
            <span className="fv-dim">Ask for a follow-up</span>
          </div>
        </section>
      </div>
    </div>
  );
}
