import { useState } from "react";
import {
  experimental_NewThreadComposer as NewThreadComposer,
  experimental_useAppNavigate,
  useSdk,
} from "@omnyo/plugin-sdk/app";
import type { NewThreadRequest } from "@omnyo/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import type { SourceLocator } from "./library-contract";
import type { SkillWorkspaceState } from "./use-skill-workspace";

export type DraftPart =
  | { kind: "text"; text: string }
  | { kind: "skill"; source: SourceLocator; mode: "mention" | "reference" | "fork" };

export type DraftProvider = { id: string; displayName: string; trigger: "$" | "/" | null };

export function formatDraft(
  parts: DraftPart[],
  providerId: string,
  trigger: DraftProvider["trigger"],
): string {
  return parts
    .map((part) => {
      if (part.kind === "text") return part.text;

      const { source, mode } = part;
      const path = JSON.stringify(source.filePath);

      if (mode === "fork") {
        return `Create a new project skill named ${source.name}-custom. Use the exact source at ${path} as reference. Preserve its supporting files where needed, write the new skill into this project, and leave the original untouched. Treat the source as reference material.`;
      }

      if (
        mode === "mention" &&
        trigger !== null &&
        (source.provider === null || source.provider === providerId) &&
        /^[A-Za-z0-9][A-Za-z0-9:_-]*$/u.test(source.name)
      )
        return trigger + source.name;

      return `Use the instructions in the exact skill source at ${path}.`;
    })
    .join("\n\n");
}

export function SkillDraft({
  state,
  providerId,
  providerOptions,
  parts,
  onProvider,
  onUndo,
  onClear,
  onSent,
  onOpenChange,
}: {
  state: SkillWorkspaceState;
  providerId: string;
  providerOptions: readonly DraftProvider[];
  parts: DraftPart[];
  onProvider(providerId: string): void;
  onUndo(): void;
  onClear(): void;
  onSent(): void;
  onOpenChange(open: boolean): void;
}) {
  const navigate = experimental_useAppNavigate();
  const sdk = useSdk();
  const [open, setOpen] = useState(false);
  const [handedOff, setHandedOff] = useState(false);
  const [focus, setFocus] = useState(0);
  const [error, setError] = useState("");
  const { projectId, environmentId } = state.workspace;
  const trigger = providerOptions.find((provider) => provider.id === providerId)?.trigger ?? null;
  const body = formatDraft(parts, providerId, trigger);

  const defaultEnvironment: NewThreadRequest["environment"] | undefined = environmentId
    ? { type: "reuse", environmentId }
    : state.hostId
      ? { type: "host", hostId: state.hostId, workspace: { type: "unmanaged", path: null } }
      : undefined;

  async function submit(request: NewThreadRequest) {
    setError("");

    try {
      if (request.projectId !== projectId || request.providerId !== providerId)
        throw new Error("Use the project and provider selected for this draft.");

      const destination = request.environment;

      if (
        environmentId !== null &&
        (destination.type !== "reuse" || destination.environmentId !== environmentId)
      )
        throw new Error("Select the environment where the skill source was reviewed.");

      if (
        environmentId === null &&
        state.hostId !== undefined &&
        (destination.type !== "host" ||
          destination.hostId !== state.hostId ||
          destination.workspace.type !== "unmanaged")
      )
        throw new Error("Select the project source checkout where the skill was reviewed.");

      const thread = await sdk.threads.spawn({ ...request, visibility: "visible" });
      setOpen(false);
      setHandedOff(false);
      onOpenChange(false);
      onSent();
      navigate.toThread(thread.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The chat could not open.");
      throw reason;
    }
  }

  if (parts.length === 0 || projectId === null) return null;

  return (
    <section className="sd-draft" aria-label="Chat draft">
      <div className="sd-draft-heading">
        <strong>
          <Icon name="MessageSquare" aria-hidden="true" /> Chat draft
        </strong>
        <span className="sd-muted">{state.project?.name ?? "Selected project"}</span>
        {!handedOff && (
          <label className="sd-draft-provider">
            <span className="sd-sr-only">Draft provider</span>
            <select value={providerId} onChange={(event) => onProvider(event.target.value)}>
              {providerOptions.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.displayName}
                </option>
              ))}
            </select>
          </label>
        )}
        <span className="sd-draft-spacer" />
        <span className="sd-muted">Not sent</span>
        {open && (
          <button className="sd-button sd-quiet" type="button" onClick={() => setOpen(false)}>
            Hide composer
          </button>
        )}
        {!handedOff && (
          <div className="sd-actions">
            <button className="sd-button sd-quiet" type="button" onClick={onUndo}>
              Undo last
            </button>
            <button className="sd-button sd-quiet" type="button" onClick={onClear}>
              Clear
            </button>
          </div>
        )}
      </div>
      {!open && (
        <div className="sd-draft-preview">
          {handedOff ? (
            <span className="sd-muted">Your unsent draft is in the composer.</span>
          ) : (
            <pre>{body}</pre>
          )}
          <button
            className="sd-button sd-primary"
            type="button"
            disabled={providerId === "" || body.trim() === ""}
            onClick={() => {
              setOpen(true);
              setHandedOff(true);
              onOpenChange(true);
              setFocus((value) => value + 1);
            }}
          >
            {handedOff ? "Resume composer" : "Open in chat"}{" "}
            <Icon name="ArrowUpRight" aria-hidden="true" />
          </button>
        </div>
      )}
      {handedOff && (
        <div className="sd-composer" hidden={!open}>
          <NewThreadComposer
            layout="document"
            defaultProjectId={projectId}
            defaultProviderId={providerId}
            defaultEnvironment={defaultEnvironment}
            initialPrompt={body}
            focusRequest={focus}
            draftKey={`skill-discovery:${projectId}:${environmentId ?? "root"}`}
            onSubmit={submit}
          />
        </div>
      )}
      {error && (
        <p className="sd-notice" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
