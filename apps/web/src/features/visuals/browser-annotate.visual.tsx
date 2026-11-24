import "./browser-annotate.css";

export const label =
  "Annotate elements in Omnyo's browser: with annotating on, you hover the Export CSV button of a local invoices page, click it, write Make this the primary button and choose Add to prompt. The note lands in the chat composer as 1. button.export-csv.";

const ROWS = [
  { id: "INV-1042", client: "Atlas Notes GmbH", total: "1.240,00 €" },
  { id: "INV-1041", client: "Harbor Supply", total: "318,50 €" },
  { id: "INV-1040", client: "Kestrel Labs", total: "2.075,00 €" },
] as const;

export function Visual() {
  return (
    <div className="fv fv-browser-annotate" aria-hidden="true">
      <header className="fv-browser-annotate-bar">
        <span className="fv-browser-annotate-nav">
          <svg viewBox="0 0 16 16">
            <path d="M10 3.5 5.5 8l4.5 4.5" />
          </svg>
          <svg viewBox="0 0 16 16">
            <path d="M6 3.5 10.5 8 6 12.5" />
          </svg>
          <svg viewBox="0 0 16 16">
            <path d="M12.5 8a4.5 4.5 0 1 1-1.3-3.2M12.5 3v2.6H9.9" />
          </svg>
        </span>
        <span className="fv-browser-annotate-url">localhost:5174/invoices</span>
        <span className="fv-browser-annotate-tool">
          <svg viewBox="0 0 16 16">
            <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" />
            <path d="M8 5.5v3M6.5 7h3" />
          </svg>
          Annotate elements
        </span>
      </header>
      <div className="fv-browser-annotate-page">
        <h3>Invoices</h3>
        <p className="fv-browser-annotate-sub">November · 3 open</p>
        <span className="fv-browser-annotate-new">New invoice</span>
        <span className="fv-browser-annotate-export">Export CSV</span>
        <table>
          <tbody>
            {ROWS.map((row) => (
              <tr key={row.id}>
                <td>{row.id}</td>
                <td>{row.client}</td>
                <td>{row.total}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <i className="fv-browser-annotate-hover" />
        <span className="fv-browser-annotate-tag">
          button.export-csv 112×32
        </span>
        <span className="fv-browser-annotate-marker">1</span>
        <div className="fv-browser-annotate-note">
          <p>button</p>
          <span className="fv-browser-annotate-field">
            <span>Make this the primary button</span>
            <i className="fv-browser-annotate-cover" />
          </span>
          <footer>
            <span>Cancel</span>
            <span className="is-primary">Add to prompt</span>
          </footer>
        </div>
        <svg viewBox="0 0 16 16" className="fv-browser-annotate-cursor">
          <path d="M3 2v11l3-2.6 2 4.4 2-1-2-4.2h4z" />
        </svg>
      </div>
      <div className="fv-browser-annotate-composer">
        <span className="fv-browser-annotate-chip">1. button.export-csv</span>
        <span className="fv-browser-annotate-placeholder">
          Ask for follow-up changes
        </span>
      </div>
    </div>
  );
}
