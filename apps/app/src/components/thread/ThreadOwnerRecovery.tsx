import { Link } from "react-router-dom";
import { Button } from "@omnyo/shared-ui/button";

type OwnerRecovery =
  | { kind: "lost-parent"; pending: boolean; takeOver: () => void }
  | { kind: "failed"; href: string; title: string }
  | { kind: "unavailable-workflow" };

export function ThreadOwnerRecovery({ recovery }: { recovery: OwnerRecovery }) {
  return (
    <section
      aria-label="Chat ownership"
      className="space-y-1 px-3 py-2 text-xs"
    >
      {recovery.kind === "lost-parent" ? (
        <>
          <p>
            This chat’s parent is unavailable. Take over to manage this chat
            directly.
          </p>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={recovery.pending}
            onClick={recovery.takeOver}
          >
            Take over chat
          </Button>
        </>
      ) : null}
      {recovery.kind === "failed" ? (
        <>
          <p>
            The owning chat hit an error. Open it to review the recovery
            options.
          </p>
          <Link to={recovery.href} className="font-medium underline">
            Open {recovery.title}
          </Link>
        </>
      ) : null}
      {recovery.kind === "unavailable-workflow" ? (
        <p>
          The workflow’s owning chat is unavailable. Open the workflow that
          started this chat to review its run.
        </p>
      ) : null}
    </section>
  );
}
