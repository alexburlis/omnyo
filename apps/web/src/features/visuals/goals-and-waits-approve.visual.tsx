export const label =
  "An agent's proposal in the Inbox to watch the staging health URL, with the exact key shown. Accepting it moves the chat to Waiting, where Omnyo checks the URL every minute and shows when it checks next.";

export function Visual() {
  return (
    <div className="fv fv-goals-and-waits-approve" aria-hidden="true">
      <header className="fv-ga-head">
        <b>Inbox</b>
        <span className="fv-pill fv-dim">All projects</span>
      </header>
      <p className="fv-ga-sec is-need">
        Needs you <span>1</span>
      </p>
      <section className="fv-ga-card">
        <p className="fv-ga-top">
          <i className="fv-dot fv-dot--attn" />
          <b>Add CSV export</b>
          <em>just now</em>
        </p>
        <p className="fv-ga-ask">Watch: staging answers with the new build?</p>
        <p className="fv-ga-key">
          <b>http:</b>https://staging.harbor-ledger.dev/health#csv-export
        </p>
        <p className="fv-ga-actions">
          <span className="is-main">Accept</span>
          <span>Reply</span>
        </p>
      </section>
      <p className="fv-ga-sec is-wait">Waiting · comes back by itself</p>
      <div className="fv-ga-row is-other">
        <i className="fv-dot fv-dot--dim" />
        <b>Weekday issue triage</b>
        <small>back Tomorrow 09:00</small>
      </div>
      <div className="fv-ga-row is-moved">
        <i className="fv-dot fv-dot--dim" />
        <b>Add CSV export</b>
        <span className="fv-ga-detail">
          <small className="is-first">checks 09:42</small>
          <small className="is-later">checked 3× · next 09:45</small>
        </span>
      </div>
      <div className="fv-ga-toast">
        <span>Accepted</span>
        <em>Undo</em>
      </div>
      <svg className="fv-ga-cursor" viewBox="0 0 16 20">
        <path d="M2 1.5v14.2l3.6-3.4 2.3 5.4 2.4-1-2.3-5.3h5z" />
      </svg>
    </div>
  );
}
