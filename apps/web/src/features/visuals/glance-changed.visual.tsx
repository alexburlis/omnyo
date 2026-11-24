import "./glance-changed.css";

export const label =
  "A Glance card that moved on since you last looked: it lists the status change from Working to Done and the new result, then Ready to archive is clicked and an Undo toast appears.";

export function Visual() {
  return (
    <div className="fv fv-glance-changed" aria-hidden="true">
      <section className="fv-gc-card">
        <p className="fv-gc-head">
          <b>Date parser tests</b>
          <span className="fv-gc-fresh">
            <i />
            Updated 2 min ago
          </span>
        </p>
        <div className="fv-gc-since">
          <p className="fv-gc-eyebrow">Since you last looked</p>
          <dl className="fv-gc-change">
            <dt>Status</dt>
            <dd>
              <s>Working</s> → <b className="is-ok">Done</b>
            </dd>
          </dl>
          <dl className="fv-gc-change">
            <dt>Now</dt>
            <dd>
              <s>7 of 9 tests pass</s> → <b>All 9 date parser tests pass</b>
            </dd>
          </dl>
          <dl className="fv-gc-change">
            <dt>Replies</dt>
            <dd>
              <b>2 new</b>
            </dd>
          </dl>
        </div>
      </section>
      <div className="fv-gc-ready">
        <svg viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="9" />
          <path d="m8 12.3 2.7 2.7L16 9.6" />
        </svg>
        <span>Ready to archive</span>
        <span className="fv-gc-keep">Keep open</span>
        <span className="fv-gc-btn">Archive</span>
      </div>
      <div className="fv-gc-toast">
        <span>Archived · Date parser tests</span>
        <em>Undo</em>
      </div>
      <svg className="fv-gc-cursor" viewBox="0 0 16 20">
        <path d="M2 1.5v14.2l3.6-3.4 2.3 5.4 2.4-1-2.3-5.3h5z" />
      </svg>
    </div>
  );
}
