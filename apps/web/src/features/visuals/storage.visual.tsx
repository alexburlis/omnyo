export const label =
  "Omnyo's Storage & retention page for one machine: thread storage by category with free disk space. Clear archived files deletes the stored files of archived threads but keeps their conversations, the archived total drops from 8.4 GB to 94 MB, free disk space rises, and a toast confirms 8.3 GB freed.";

function Glyph({ d, className }: { d: string; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

function Roll({ values }: { values: readonly string[] }) {
  return (
    <span className="fv-storage-roll">
      <span className="fv-storage-reel">
        {values.map((value) => (
          <span key={value}>{value}</span>
        ))}
      </span>
    </span>
  );
}

const TOTAL = ["12.4 GB", "9.6 GB", "6.9 GB", "4.1 GB"] as const;

const ARCHIVED = ["8.4 GB", "5.6 GB", "2.8 GB", "94 MB"] as const;

const FREE = ["452.1 GB", "454.9 GB", "457.6 GB", "460.4 GB"] as const;

export function Visual() {
  return (
    <div className="fv fv-storage" aria-hidden="true">
      <div className="fv-storage-top">
        <Glyph d="M5 6c0-1.4 3.1-2.5 7-2.5s7 1.1 7 2.5-3.1 2.5-7 2.5S5 7.4 5 6ZM5 6v6c0 1.2 2.3 2.2 5.5 2.4M19 6v4.5M5 12v6c0 1.3 2.7 2.4 6.3 2.5M15 15.5a3.2 3.2 0 1 0 1-2.3M15 12.5v1.2h1.2" />
        <b>Storage &amp; retention</b>
        <Glyph className="fv-storage-close" d="M17 7 7 17M7 7l10 10" />
      </div>
      <div className="fv-storage-body">
        <p className="fv-storage-back">
          <Glyph d="M19 12H5M11 6l-6 6 6 6" />
          All machines
        </p>
        <div className="fv-storage-head">
          <div className="fv-storage-who">
            <p className="fv-storage-name">
              <b>studio-mac</b>
              <span className="fv-storage-pill">server</span>
              <span className="fv-storage-online">
                <i />
                Online
              </span>
            </p>
            <p className="fv-storage-sub">
              Review stored files and free up space on this machine.
            </p>
          </div>
          <span className="fv-storage-rescan">
            <Glyph d="M20 12a8 8 0 1 1-2.4-5.7L20 8.5M20 3.5v5h-5" />
            Rescan machine
          </span>
        </div>
        <section className="fv-storage-card">
          <p className="fv-storage-total">
            <span>Total</span>
            <b>
              <Roll values={TOTAL} />
            </b>
          </p>
          <table className="fv-storage-table">
            <thead>
              <tr>
                <th>Category</th>
                <th>Count</th>
                <th>Size</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th>Active threads</th>
                <td>14</td>
                <td>3.9 GB</td>
              </tr>
              <tr className="is-cleared">
                <th>Archived threads</th>
                <td>52</td>
                <td>
                  <Roll values={ARCHIVED} />
                </td>
              </tr>
              <tr>
                <th>Orphaned</th>
                <td>3</td>
                <td>83 MB</td>
              </tr>
            </tbody>
          </table>
          <p className="fv-storage-disk">
            Disk space: <Roll values={FREE} /> free of 994.7 GB
            <br />
            Scanned 4m ago
          </p>
        </section>
        <section className="fv-storage-section">
          <p className="fv-storage-h">Clean up</p>
          <div className="fv-storage-clean">
            <div className="fv-storage-clean-text">
              <p>
                All files in archived threads{" "}
                <span className="fv-storage-size">
                  <Roll values={ARCHIVED} />
                </span>
              </p>
              <p className="fv-storage-desc">
                Clear stored files from 52 archived threads. Conversations and
                uploaded attachments are kept.
              </p>
            </div>
            <span className="fv-storage-action">
              <svg className="fv-storage-spin" viewBox="0 0 24 24">
                <path d="M12 3.5a8.5 8.5 0 1 0 8.5 8.5" />
              </svg>
              <span className="fv-storage-label">Clear archived files</span>
            </span>
          </div>
        </section>
      </div>
      <div className="fv-storage-toast">
        <Glyph d="M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18ZM8.5 12.2l2.3 2.3 4.7-4.8" />
        <p>
          <b>Archived thread files deleted</b>
          <span>studio-mac · 8.3 GB freed</span>
        </p>
      </div>
    </div>
  );
}
