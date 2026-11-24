import type { WorkflowReleaseSummary } from "./catalog";

export function WorkflowRun({
  target,
  limit,
}: WorkflowReleaseSummary["candidateBudget"]) {
  return (
    <section className="wf-section" aria-labelledby="wf-run-heading">
      <div className="wf-section-head">
        <h2 id="wf-run-heading">What happens on each run</h2>
        <p className="wf-section-lead">
          The writer and reviewer work from the supplied brief. Neither can
          browse or publish.
        </p>
      </div>
      <ol className="wf-flow" role="list">
        <li className="wf-flow-card">
          <h3>Pin the brief</h3>
          <p>
            Keep the facts, source links, past topics and rules for this run.
          </p>
        </li>
        <li className="wf-flow-card">
          <h3>Draft one topic</h3>
          <p>Write a Markdown draft and cite the supplied sources.</p>
        </li>
        <li className="wf-flow-review">
          <div className="wf-flow-card wf-flow-decision">
            <h3>Review the exact draft</h3>
            <p>
              Independently check claim support, originality and completeness.
            </p>
          </div>
          <ul
            className="wf-flow-branches"
            role="list"
            aria-label="Review decisions"
          >
            <li className="wf-flow-card">
              <h4>Accept</h4>
              <p>Add the draft only if its topic is unique in the week.</p>
            </li>
            <li className="wf-flow-card">
              <h4>Revise</h4>
              <p>
                Rewrite once using the feedback. Review that version again and
                keep it only if it passes and its topic is unique.
              </p>
            </li>
            <li className="wf-flow-card">
              <h4>Skip</h4>
              <p>Move past rejected, duplicate or still unapproved drafts.</p>
            </li>
          </ul>
        </li>
        <li className="wf-flow-card wf-flow-next">
          <h3>Check the week</h3>
          <p>
            Draft another topic until {target} are accepted or all {limit}{" "}
            candidates have been tried. If the limit is reached first, the run
            reports how many were accepted.
          </p>
        </li>
      </ol>
      <div className="wf-flow-delivery">
        <h3>What a complete run delivers</h3>
        <dl className="wf-outcomes">
          <div className="wf-flow-card">
            <dt>{target} Markdown drafts</dt>
            <dd>
              Editable articles with their claims checked against your brief.
            </dd>
          </div>
          <div className="wf-flow-card">
            <dt>Delivery calendar</dt>
            <dd>One draft per day starting on your chosen weekday.</dd>
          </div>
          <div className="wf-flow-card">
            <dt>Review record</dt>
            <dd>The accepted decision tied to each exact draft.</dd>
          </div>
        </dl>
      </div>
    </section>
  );
}
