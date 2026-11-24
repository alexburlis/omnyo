import type { WorkflowPreview } from "./weekly-content-feed-preview";

type Week = Pick<WorkflowPreview, "company" | "days">;

const shortDay = (day: string) => day.slice(0, 3);

function SheetHead({ week, headingId }: { week: Week; headingId?: string }) {
  return (
    <div className="wf-sheet-head">
      <p className="wf-label" id={headingId}>
        A week for {week.company}
      </p>
      <p className="wf-label">{week.days.length} drafts</p>
    </div>
  );
}

export function WeekArt({ week }: { week: Week }) {
  return (
    <div className="wf-sheet wf-sheet--art" aria-hidden="true">
      <SheetHead week={week} />
      <ol className="wf-week">
        {week.days.map((entry) => (
          <li key={entry.day}>
            <span className="wf-week-row">
              <span className="wf-week-day">{shortDay(entry.day)}</span>
              <span className="wf-week-topic">{entry.topic}</span>
              <span className="wf-week-format">{entry.format}</span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function WeekPicker({
  week,
  context,
  selected,
  onSelect,
}: {
  week: Week;
  context: string;
  selected: number;
  onSelect: (index: number) => void;
}) {
  return (
    <section className="wf-sheet" aria-labelledby="wf-week-heading">
      <SheetHead week={week} headingId="wf-week-heading" />
      <ol className="wf-week" aria-label="Seven-day example calendar">
        {week.days.map((entry, index) => {
          const active = index === selected;

          return (
            <li key={entry.day} className={active ? "is-active" : undefined}>
              <button
                type="button"
                className="wf-week-row"
                aria-pressed={active}
                onClick={() => onSelect(index)}
              >
                <span className="wf-week-day">
                  <span aria-hidden="true">{shortDay(entry.day)}</span>
                  <span className="wf-sr">{entry.day}</span>
                </span>
                <span className="wf-week-topic">{entry.topic}</span>
                <span className="wf-week-format">{entry.format}</span>
              </button>
              {active ? (
                <p className="wf-week-angle">
                  {entry.angle}
                  {index === 0 && (
                    <>
                      {" "}
                      <a href="#wf-draft-heading">Read the post ↓</a>
                    </>
                  )}
                </p>
              ) : null}
            </li>
          );
        })}
      </ol>
      <p className="wf-sheet-note">{context}</p>
    </section>
  );
}
