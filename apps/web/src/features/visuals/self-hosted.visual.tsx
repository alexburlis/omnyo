export const label =
  "Omnyo settings on your own machine: the Omnyo server on studio-mac is running, two machines are connected, Claude Code and Codex are signed in, and no account is needed.";

export function Visual() {
  return (
    <div className="fv fv-self-hosted" aria-hidden="true">
      <div className="fv-self-hosted-card fv-panel">
        <div className="fv-self-hosted-head">
          <svg className="fv-self-hosted-icon" viewBox="0 0 32 32">
            <rect x="4" y="4" width="24" height="10" rx="2.5" />
            <rect x="4" y="18" width="24" height="10" rx="2.5" />
            <circle className="is-on" cx="9.5" cy="9" r="1.6" />
            <circle className="is-on" cx="9.5" cy="23" r="1.6" />
          </svg>
          <p className="fv-self-hosted-name">
            <b>Omnyo server</b>
            <span className="fv-mono fv-dim">studio-mac</span>
          </p>
          <span className="fv-pill fv-self-hosted-run">
            <i className="fv-dot fv-dot--ok" />
            Running
          </span>
        </div>
        <dl className="fv-self-hosted-rows">
          <dt>Machines</dt>
          <dd>
            <b>2 connected</b>
            <span className="fv-self-hosted-chips">
              <span className="fv-pill">
                <i className="fv-dot fv-dot--ok" />
                studio-mac
                <em>server</em>
              </span>
              <span className="fv-pill">
                <i className="fv-dot fv-dot--ok" />
                build-box
              </span>
            </span>
          </dd>
          <dt>Agents</dt>
          <dd className="fv-self-hosted-agents">
            <span>
              Claude Code
              <span className="fv-self-hosted-ok">
                <i className="fv-dot fv-dot--ok" />
                Signed in
              </span>
            </span>
            <span>
              Codex
              <span className="fv-self-hosted-ok">
                <i className="fv-dot fv-dot--ok" />
                Signed in
              </span>
            </span>
          </dd>
          <dt>Account</dt>
          <dd className="fv-soft">None needed</dd>
        </dl>
      </div>
    </div>
  );
}
