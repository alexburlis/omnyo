import { experimental_Icon as Icon } from "@omnyo/plugin-sdk/app";
import {
  ALWAYS_SHOWN_SECTION,
  INBOX_SECTION_LABEL,
  isDefaultSections,
  resetInboxSections,
  setInboxSectionShown,
  setInboxShowEmpty,
  stepInboxSection,
  useInboxSections,
} from "../lib/inbox-order.ts";

export function InboxSectionSettings() {
  const sections = useInboxSections();
  const last = sections.order.length - 1;

  return (
    <div className="ct-tags">
      <p className="ct-tags-hint">
        Choose which Inbox sections appear and in what order. Needs you can’t be hidden, and
        sections with no chats stay out unless you show empty sections. You can also right-click the
        Inbox. This device remembers your choice.
      </p>
      <ol className="ct-tags-list" aria-label="Inbox sections">
        {sections.order.map((key, index) => {
          const label = INBOX_SECTION_LABEL[key];
          const locked = key === ALWAYS_SHOWN_SECTION;

          return (
            <li key={key} className="ct-inbox-row" data-inbox-section={key}>
              <label className="ct-inbox-toggle">
                <input
                  type="checkbox"
                  checked={!sections.hidden.has(key)}
                  disabled={locked}
                  title={locked ? "Needs you can’t be hidden" : undefined}
                  onChange={(event) => setInboxSectionShown(key, event.currentTarget.checked)}
                />
                <span>{label}</span>
              </label>
              <span className="ct-tags-actions">
                <button
                  type="button"
                  className="ct-tags-button"
                  aria-label={`Move ${label} up`}
                  disabled={index === 0}
                  onClick={() => stepInboxSection(key, -1)}
                >
                  <Icon name="ArrowUp" aria-hidden className="size-3.5" />
                </button>
                <button
                  type="button"
                  className="ct-tags-button"
                  aria-label={`Move ${label} down`}
                  disabled={index === last}
                  onClick={() => stepInboxSection(key, 1)}
                >
                  <Icon name="ArrowDown" aria-hidden className="size-3.5" />
                </button>
              </span>
            </li>
          );
        })}
      </ol>
      <label className="ct-inbox-toggle">
        <input
          type="checkbox"
          checked={sections.showEmpty}
          onChange={(event) => setInboxShowEmpty(event.currentTarget.checked)}
        />
        <span>Show empty sections</span>
      </label>
      <div>
        <button
          type="button"
          className="ct-tags-add"
          disabled={isDefaultSections(sections)}
          onClick={resetInboxSections}
        >
          Reset to default
        </button>
      </div>
    </div>
  );
}
