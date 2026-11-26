import type { CSSProperties } from "react";

export const label =
  "A chat beside Omnyo's browser panel. A bar above the page says Browser Automation is controlling this tab. The agent loads the invoices page of a local app, clicks Export CSV, sees the download confirmed and reports back in the chat.";

const INVOICES = [
  {
    client: "Northwind Studio",
    date: "12 Nov",
    amount: "€1,240.00",
    paid: true,
  },
  { client: "Fjord Analytics", date: "9 Nov", amount: "€860.00", paid: false },
  { client: "Kestrel & Co", date: "4 Nov", amount: "€2,115.50", paid: true },
  { client: "Lumen Labs", date: "1 Nov", amount: "€430.00", paid: true },
  { client: "Orchard Bikes", date: "28 Oct", amount: "€975.00", paid: false },
] as const;

function Glyph({ d, className }: { d: string; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

const GLOBE =
  "M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18ZM3 12h18M12 3c2.6 2.6 2.6 15.4 0 18M12 3c-2.6 2.6-2.6 15.4 0 18";

export function Visual() {
  return (
    <div className="fv fv-browser" aria-hidden="true">
      <section className="fv-browser-chat">
        <p className="fv-browser-user">Check the Export CSV button.</p>
        <p className="fv-browser-say">
          The page is open in the browser. Clicking Export CSV now.
        </p>
        <p className="fv-browser-swap">
          <span className="fv-browser-working">Working…</span>
          <span className="fv-browser-done">
            Export CSV works: invoices.csv has all 5 rows.
          </span>
        </p>
        <div className="fv-browser-composer">
          <p>Ask for a follow-up</p>
          <p className="fv-browser-bar">
            <Glyph d="M12 5v14M5 12h14" />
            <span className="fv-browser-model">
              <Glyph
                className="fv-browser-mark"
                d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4"
              />
              <Glyph d="m6 9 6 6 6-6" />
            </span>
            <Glyph
              className="fv-browser-mic"
              d="M12 3.5a3 3 0 0 0-3 3v4.5a3 3 0 0 0 6 0V6.5a3 3 0 0 0-3-3ZM5.5 11a6.5 6.5 0 0 0 13 0M12 17.5v3"
            />
            <span className="fv-browser-stop">
              <i />
              <Glyph d="M12 19V5M5.5 11.5 12 5l6.5 6.5" />
            </span>
          </p>
        </div>
      </section>
      <section className="fv-browser-panel">
        <div className="fv-browser-tabs">
          <Glyph d="M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18ZM12 16v-4.5M12 8h.01" />
          <span className="fv-browser-tab">
            <Glyph d={GLOBE} />
            Invoices · Harbor Ledger
          </span>
          <Glyph d="M12 5v14M5 12h14" />
          <Glyph
            className="fv-browser-end"
            d="M15 4h5v5M9 20H4v-5M20 4l-6 6M4 20l6-6"
          />
        </div>
        <div className="fv-browser-nav">
          <Glyph d="m15 18-6-6 6-6" />
          <Glyph className="is-off" d="m9 18 6-6-6-6" />
          <span className="fv-browser-reload">
            <Glyph d="M20 12a8 8 0 1 1-2.4-5.7L20 8.5M20 3.5v5h-5" />
            <Glyph d="M17 7 7 17M7 7l10 10" />
          </span>
          <span className="fv-browser-url">
            <Glyph
              className="fv-browser-warn"
              d="M12 4 2.8 19.5h18.4L12 4ZM12 10v4.2M12 17h.01"
            />
            <span>http://localhost:5174/invoices</span>
          </span>
          <Glyph d="M14 4h6v6M20 4l-8.5 8.5M18 14v6H4V6h6" />
        </div>
        <div className="fv-browser-banner">
          <span className="fv-browser-who">
            Browser Automation is controlling this tab
          </span>
          <span>Stop</span>
          <span>Take over</span>
        </div>
        <div className="fv-browser-page">
          <span className="fv-browser-load" />
          <div className="fv-browser-doc">
            <div className="fv-browser-site">
              <b>
                <i />
                Harbor Ledger
              </b>
              <span className="is-on">Invoices</span>
              <span>Clients</span>
              <span>Reports</span>
            </div>
            <div className="fv-browser-head">
              <b>Invoices</b>
              <span className="fv-browser-export">
                Export CSV
                <span className="fv-browser-ripple" />
                <svg className="fv-browser-cursor" viewBox="0 0 24 24">
                  <path d="M5 2.5v17l4.6-4.2 2.8 6.3 2.9-1.3-2.7-6.1h6.2Z" />
                </svg>
              </span>
            </div>
            <table className="fv-browser-table">
              <thead>
                <tr>
                  <th>Client</th>
                  <th>Date</th>
                  <th>Amount</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {INVOICES.map((row, index) => (
                  <tr
                    key={row.client}
                    style={{ "--i": index } as CSSProperties}
                  >
                    <td>{row.client}</td>
                    <td>{row.date}</td>
                    <td>{row.amount}</td>
                    <td>
                      <span className={row.paid ? "is-paid" : "is-due"}>
                        {row.paid ? "Paid" : "Due"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="fv-browser-toast">
            <Glyph d="M20 6 9 17l-5-5" />
            <span>
              Exported <b>invoices.csv</b>
            </span>
          </p>
        </div>
      </section>
    </div>
  );
}
