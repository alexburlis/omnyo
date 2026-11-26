export const label =
  "A new worktree being prepared: Omnyo fetches main, creates the worktree, copies .env files listed in .worktreeinclude, streams the output of .omnyo-env-setup.sh, then starts the agent.";

function Check() {
  return (
    <svg viewBox="0 0 16 16">
      <path d="m3.5 8.4 2.9 2.9 6.1-6.6" />
    </svg>
  );
}

const STEPS = [
  "Fetched main",
  "Created worktree",
  "Copied 2 file(s) from .worktreeinclude",
  "Running .omnyo-env-setup.sh",
] as const;

export function Visual() {
  return (
    <div className="fv fv-parallel-agents-setup" aria-hidden="true">
      <section className="fv-ps-log">
        <p className="fv-ps-title">
          <b>Setting up</b>
          <span>omnyo/csv-export</span>
        </p>
        {STEPS.map((step) => (
          <div key={step} className="fv-ps-step">
            <Check />
            <code>{step}</code>
          </div>
        ))}
        <pre className="fv-ps-out">
          {"$ pnpm install --frozen-lockfile\nPackages: +412\nDone in 4.2s"}
        </pre>
        <div className="fv-ps-step">
          <Check />
          <code>.omnyo-env-setup.sh finished</code>
        </div>
        <p className="fv-ps-agent">
          <i className="fv-dot" />
          Agent started · Add CSV export
        </p>
      </section>
      <aside className="fv-ps-side">
        <div className="fv-ps-file">
          <p>.worktreeinclude</p>
          <pre>
            {".env\n.env.*\n"}
            <i>!.env.example</i>
          </pre>
        </div>
        <div className="fv-ps-copy">
          <span>.env</span>
          <span>.env.local</span>
        </div>
      </aside>
    </div>
  );
}
