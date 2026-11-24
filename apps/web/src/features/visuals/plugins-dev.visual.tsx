import "./plugins-dev.css";

export const label =
  "Building a plugin: in a terminal, omnyo plugin new invoices scaffolds it and omnyo plugin dev watches it. Omnyo reloads the plugin, an Invoice totals panel appears in the sidebar, and after the next save the panel gains an overdue line without a restart.";

export function Visual() {
  return (
    <div className="fv fv-plugins-dev" aria-hidden="true">
      <div className="fv-pd-term">
        <p className="fv-pd-term-bar">
          <i />
          <i />
          <i />
          <span>harbor-ledger</span>
        </p>
        <div className="fv-pd-lines fv-mono">
          <p className="fv-pd-l1">
            <b>$</b> omnyo plugin new invoices
          </p>
          <p className="fv-pd-l2 fv-dim">Created ./omnyo-plugin-invoices</p>
          <p className="fv-pd-l3">
            <b>$</b> omnyo plugin dev
          </p>
          <p className="fv-pd-l4 fv-dim">Watching omnyo-plugin-invoices</p>
          <p className="fv-pd-l5">
            <em>✓</em> rebuilt frontend · reloaded
          </p>
          <p className="fv-pd-l6 fv-dim">panel.tsx changed</p>
          <p className="fv-pd-l7">
            <em>✓</em> rebuilt frontend · reloaded
          </p>
        </div>
      </div>
      <div className="fv-pd-app">
        <nav className="fv-pd-side">
          <p className="fv-pd-row">Inbox</p>
          <p className="fv-pd-row">Automations</p>
          <p className="fv-pd-row is-new">
            <i />
            Invoice totals
          </p>
          <p className="fv-eyebrow">Chats</p>
          <p className="fv-pd-row fv-dim">Add CSV export</p>
          <p className="fv-pd-row fv-dim">Date parser tests</p>
        </nav>
        <div className="fv-pd-panel">
          <div className="fv-pd-card">
            <p className="fv-eyebrow">Invoice totals</p>
            <p className="fv-pd-big">$12,480</p>
            <p className="fv-dim">38 invoices this month</p>
            <p className="fv-pd-over">
              <i className="fv-dot fv-dot--attn" />3 overdue · $1,920
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
