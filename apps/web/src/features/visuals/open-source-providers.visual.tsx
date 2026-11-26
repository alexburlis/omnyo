export const label =
  "Omnyo's provider plugins: Claude Code Provider and Codex Provider are on, Pi Provider and ACP Providers are off. ACP Providers is switched on, and the new chat's agent menu gains Cursor and opencode beside Claude Code and Codex.";

const PLUGINS = [
  {
    id: "claude",
    name: "Claude Code Provider",
    body: "Run chats with Claude Code.",
    state: "on",
  },
  {
    id: "codex",
    name: "Codex Provider",
    body: "Run chats with Codex.",
    state: "on",
  },
  {
    id: "pi",
    name: "Pi Provider",
    body: "Run chats with Pi.",
    state: "off",
  },
  {
    id: "acp",
    name: "ACP Providers",
    body: "Cursor, opencode, omp and more.",
    state: "flip",
  },
] as const;

const AGENTS = [
  { name: "Claude Code", added: false, picked: true },
  { name: "Codex", added: false, picked: false },
  { name: "Cursor", added: true, picked: false },
  { name: "opencode", added: true, picked: false },
] as const;

export function Visual() {
  return (
    <div className="fv fv-open-source-providers" aria-hidden="true">
      <section className="fv-osp-plugins">
        <p className="fv-eyebrow">Agents and providers</p>
        <ul>
          {PLUGINS.map((plugin) => (
            <li key={plugin.id} className={`fv-osp-row is-${plugin.state}`}>
              <span className="fv-osp-copy">
                <b>{plugin.name}</b>
                <span className="fv-dim">{plugin.body}</span>
              </span>
              <span className="fv-osp-switch">
                <i className="fv-osp-fill" />
                <i className="fv-osp-thumb" />
              </span>
            </li>
          ))}
        </ul>
        <svg className="fv-osp-cursor" viewBox="0 0 16 20">
          <path d="M2 1.5v14.2l3.6-3.4 2.4 5.6 2.5-1.1-2.4-5.5H13z" />
        </svg>
      </section>
      <section className="fv-osp-new">
        <p className="fv-eyebrow">New chat</p>
        <div className="fv-osp-menu">
          {AGENTS.map((agent) => (
            <p
              key={agent.name}
              className={`fv-osp-agent ${agent.added ? "is-added" : ""} ${
                agent.picked ? "is-picked" : ""
              }`}
            >
              <i />
              {agent.name}
              {agent.picked ? (
                <svg viewBox="0 0 16 16">
                  <path d="M3.5 8.5 6.5 11.5 12.5 5" />
                </svg>
              ) : null}
            </p>
          ))}
        </div>
        <div className="fv-osp-composer">
          <span className="fv-dim">Add a CSV export</span>
          <span className="fv-osp-pill">Claude Code</span>
        </div>
      </section>
    </div>
  );
}
