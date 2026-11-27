import { AttentionCard } from "../attention/AttentionCard.js";
import { useAttention } from "../data/hooks.js";
import { EmptyState, ErrorAlert, Skeleton } from "../primitives.js";
import { Page } from "../shell.js";

export function AttentionInbox() {
  const attention = useAttention(null, null);
  const items = [...(attention.data ?? [])].sort((a, b) => a.createdAt - b.createdAt);

  return (
    <Page
      crumbs={[
        { label: "State machines", route: { screen: "list" } },
        { label: "Needs you", route: null },
      ]}
      title="Needs you"
    >
      {attention.error !== null ? (
        <ErrorAlert error={attention.error} onRetry={attention.refetch} />
      ) : null}
      {attention.data === undefined && attention.error === null ? (
        <Skeleton rows={2} height={120} />
      ) : null}
      {attention.data !== undefined && items.length === 0 ? (
        <EmptyState title="Nothing needs you." />
      ) : null}
      <div className="stm-stack">
        {items.map((item) => (
          <AttentionCard key={item.attentionId} item={item} />
        ))}
      </div>
    </Page>
  );
}
