export const label =
  "Two chats wait for a slot on a full Mac running 8 of 8 chats. When one chat finishes, the first waiting chat takes its slot; with overflow on, the second starts on a second Mac that has room.";

const SLOTS_A = 8;

const SLOTS_B = 16;

const BUSY_B = new Set([0, 1, 2]);

export function Visual() {
  return (
    <div className="fv fv-parallel-agents-queue" aria-hidden="true">
      <p className="fv-pq-label">Waiting for a slot</p>
      <p className="fv-pq-chip is-1">
        <b>Date parser tests</b>
        <small>harbor-ledger</small>
      </p>
      <p className="fv-pq-chip is-2">
        <b>Weekday issue triage</b>
        <small>atlas-notes</small>
      </p>
      <section className="fv-pq-machine is-a">
        <p className="fv-pq-head">
          <b>studio-mac</b>
          <small>
            <span>8 of 8 · one per processor</span>
          </small>
        </p>
        <div className="fv-pq-slots">
          {Array.from({ length: SLOTS_A }, (_, index) => (
            <span
              key={index}
              className={`fv-pq-slot${index === 5 ? " is-done" : ""}`}
            >
              <i />
              {index === 5 ? <b>✓</b> : null}
            </span>
          ))}
        </div>
      </section>
      <section className="fv-pq-machine is-b">
        <p className="fv-pq-head">
          <b>mac-mini</b>
          <small>
            <span className="is-before">3 of 16</span>
            <span className="is-after">4 of 16</span>
          </small>
        </p>
        <div className="fv-pq-slots">
          {Array.from({ length: SLOTS_B }, (_, index) => (
            <span
              key={index}
              className={`fv-pq-slot${BUSY_B.has(index) ? "" : " is-free"}${index === 3 ? " is-take" : ""}`}
            >
              <i />
            </span>
          ))}
        </div>
      </section>
      <div className="fv-pq-settings">
        <p>
          Host limit
          <span>Auto · one per processor</span>
        </p>
        <p>
          Start waiting chats on a free machine
          <i className="fv-pq-switch" />
        </p>
      </div>
      <p className="fv-pq-moved">
        Started on mac-mini because studio-mac was full.
      </p>
      <i className="fv-pq-token is-1" />
      <i className="fv-pq-token is-2" />
    </div>
  );
}
