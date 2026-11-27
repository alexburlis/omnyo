import { useCallback, useEffect, useRef, useState } from "react";
import { UrlLink, useRpc } from "@omnyo/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import type { Collection, Workspace } from "./library-contract";
import type { libraryRpc } from "./library-rpc";
import { packDigestSchema, packSlugSchema, skillPackSchema } from "./pack";
import type { SkillPack } from "./pack";
import type { SkillWorkspaceState } from "./use-skill-workspace";
import type { z } from "zod";
import type { packConfirmResult, packReviewInput, packReviewResult } from "./pack";

export type PackInput = z.infer<typeof packReviewInput>["source"];

type Review = z.infer<typeof packReviewResult>;

type Receipt = z.infer<typeof packConfirmResult>;

export function linkedReview(subPath: string): PackInput | null {
  const [route, slug, digest, extra] = subPath.replace(/^\//u, "").split("/");

  if (extra !== undefined || !packDigestSchema.safeParse(digest).success) return null;

  if (route === "import" && packSlugSchema.safeParse(slug).success)
    return { kind: "published", slug, digest };

  if (route === "source" && slug.length <= 160 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug))
    return { kind: "marketplace", slug, digest };

  return null;
}

function readPack(input: string): SkillPack {
  return skillPackSchema.parse(JSON.parse(input));
}

function PackContents({ pack, inspect }: { pack: SkillPack; inspect: boolean }) {
  return (
    <div className="sd-pack-contents">
      <h3>Pack contents</h3>
      <ul>
        {pack.skills.map((skill) => (
          <li key={skill.id}>
            <strong>{skill.id}</strong>
            <ul>
              {skill.files.map((file) => (
                <li key={file.path}>
                  {inspect ? (
                    <details>
                      <summary>
                        <code>{file.path}</code>
                      </summary>
                      <pre className="sd-file-content">{file.content}</pre>
                    </details>
                  ) : (
                    <code>{file.path}</code>
                  )}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      {pack.prompts.length > 0 && (
        <div>
          <h3>Saved prompts</h3>
          <ul>
            {pack.prompts.map((prompt, index) => (
              <li key={`${index}:${prompt.title}`}>
                {inspect ? (
                  <details>
                    <summary>{prompt.title}</summary>
                    <pre className="sd-file-content">{prompt.body}</pre>
                  </details>
                ) : (
                  <span>{prompt.title}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function PackExplorer({
  source,
  invalidLink,
  onCancel,
  onChooseFile,
  state,
  onOpenCollection,
  onInstallBusy,
}: {
  source: PackInput | null;
  invalidLink: boolean;
  onCancel(): void;
  onChooseFile(): void;
  state: SkillWorkspaceState;
  onOpenCollection(receipt: Receipt): void;
  onInstallBusy(busy: boolean): void;
}) {
  const rpc = useRpc<typeof libraryRpc>();
  const [binding, setBinding] = useState<{ source: PackInput; review: Review } | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [error, setError] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const [installing, setInstalling] = useState(false);

  const autoStarted = useRef<{
    source: PackInput;
    projectId: string;
    environmentId: string | null;
  } | null>(null);

  const reviewRunning = useRef(false);
  const canReview = state.workspace.projectId !== null && state.rootPath !== null;
  const { projectId, environmentId } = state.workspace;
  const review = binding?.source === source ? binding.review : null;

  useEffect(() => {
    setBinding(null);
    setReceipt(null);
    setError("");
  }, [projectId, environmentId, source]);

  const startReview = useCallback(async () => {
    if (!source || projectId === null || !canReview || reviewRunning.current || installing) return;

    reviewRunning.current = true;
    setError("");
    setReviewing(true);

    try {
      const next = await rpc.call("packReview", { projectId, environmentId, source });

      setBinding({ source, review: next });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Try again.");
    } finally {
      reviewRunning.current = false;
      setReviewing(false);
    }
  }, [canReview, environmentId, installing, projectId, rpc, source]);

  useEffect(() => {
    if (source === null || projectId === null || !canReview || reviewing || installing) return;

    const previous = autoStarted.current;

    if (
      previous?.source === source &&
      previous.projectId === projectId &&
      previous.environmentId === environmentId
    )
      return;

    autoStarted.current = { source, projectId, environmentId };
    void startReview();
  }, [canReview, environmentId, installing, projectId, reviewing, source, startReview]);

  async function confirm() {
    if (
      review === null ||
      review.projectId !== projectId ||
      review.environmentId !== environmentId ||
      installing
    )
      return;
    setInstalling(true);
    onInstallBusy(true);
    setError("");

    try {
      setReceipt(
        await rpc.call("packConfirm", { reviewId: review.reviewId, digest: review.digest }),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Try again.");
    } finally {
      setInstalling(false);
      onInstallBusy(false);
    }
  }

  function cancel() {
    setBinding(null);
    setReceipt(null);
    setError("");

    onCancel();
  }

  const hasReview =
    review !== null && review.projectId === projectId && review.environmentId === environmentId;

  return (
    <div className="sd-pack-review" data-drop-zone={source === null}>
      <p className="sd-kind">
        <Icon name="Archive" aria-hidden="true" />{" "}
        {source?.kind === "local" || source?.kind === "published" ? "Skill pack" : "Skill import"}
      </p>
      <h2 className="sd-title" data-sd-heading tabIndex={-1}>
        {receipt
          ? `${receipt.pack.title} is installed`
          : hasReview
            ? `Install ${review.pack.title}`
            : source
              ? "Review skill import"
              : "Import skills"}
      </h2>
      {receipt ? (
        <>
          <p className="sd-summary">
            Installed in{" "}
            {state.projectList.find((project) => project.id === receipt.projectId)?.name ??
              "the reviewed project"}
            .
          </p>
          <p className="sd-muted">
            Receipt <code>{receipt.receipt}</code>
          </p>
          <button
            className="sd-button sd-primary"
            type="button"
            onClick={() => onOpenCollection(receipt)}
          >
            Open collection
          </button>
        </>
      ) : (
        <>
          <div className="sd-pack-destination">
            <span>Destination</span>
            <strong>{state.project?.name ?? "Choose a project"}</strong>
            {state.rootPath && <code>{state.rootPath}</code>}
          </div>
          {hasReview ? (
            <>
              <p className="sd-summary">{review.pack.description}</p>
              <dl className="sd-meta">
                <dt>Source</dt>
                <dd>
                  {source?.kind === "marketplace" ? (
                    <UrlLink href={`https://omnyohq.com/explore/skills/source/${source.slug}`}>
                      Marketplace listing
                    </UrlLink>
                  ) : source?.kind === "published" ? (
                    "omnyohq.com"
                  ) : source?.kind === "markdown" ? (
                    source.filename
                  ) : (
                    "Local file"
                  )}
                </dd>
                <dt>Publisher</dt>
                <dd>{review.pack.publisher}</dd>
                <dt>Version</dt>
                <dd>{review.pack.version}</dd>
                <dt>License</dt>
                <dd>{review.pack.license}</dd>
                <dt>SHA-256</dt>
                <dd>
                  <code>{review.digest}</code>
                </dd>
              </dl>
              {review.destination === "installed" ? (
                <p className="sd-notice">
                  <strong>Installed</strong> This version already has a receipt.
                </p>
              ) : review.destination === "recoverable" ? (
                <p className="sd-notice">
                  Resume the previous installation with the same reviewed files.
                </p>
              ) : null}
              {source?.kind === "marketplace" && review.pack.publisher === "local" && (
                <p className="sd-notice">
                  This import contains only SKILL.md. Check the source for any required files or
                  setup.
                </p>
              )}
              <PackContents pack={review.pack} inspect />
              <div className="sd-actions">
                <button
                  className="sd-button sd-primary"
                  type="button"
                  onClick={() => void confirm()}
                  disabled={installing}
                >
                  {installing
                    ? "Installing…"
                    : review.destination === "installed"
                      ? "Open installed pack"
                      : review.destination === "recoverable"
                        ? "Resume install"
                        : `Install in ${state.project?.name ?? "project"}`}
                </button>
                <button className="sd-button" type="button" onClick={cancel} disabled={installing}>
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <>
              {invalidLink && (
                <p role="alert" className="sd-notice">
                  This link is missing a valid skill ID and revision.
                </p>
              )}
              <p className="sd-summary">
                {source
                  ? "Confirm the destination, then review the files and prompts."
                  : "Drop a Markdown file or skill pack here."}
              </p>
              <div className="sd-actions">
                {source ? (
                  <>
                    <button
                      type="button"
                      className="sd-button sd-primary"
                      disabled={!canReview || reviewing}
                      onClick={() => void startReview()}
                    >
                      {reviewing ? "Preparing review…" : error ? "Retry review" : "Review pack"}
                    </button>
                    <button
                      type="button"
                      className="sd-button"
                      disabled={reviewing}
                      onClick={cancel}
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button className="sd-button sd-primary" type="button" onClick={onChooseFile}>
                    Choose file
                  </button>
                )}
              </div>
              {source && !canReview && (
                <p className="sd-muted">Select a project with a checkout to review this pack.</p>
              )}
            </>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="sd-notice">
          {error}
        </p>
      )}
    </div>
  );
}

export function PackExportForm({
  workspace,
  collection,
  onClose,
}: {
  workspace: Workspace;
  collection: Collection;
  onClose(): void;
}) {
  const rpc = useRpc<typeof libraryRpc>();

  const [preview, setPreview] = useState<{ url: string; digest: string; pack: SkillPack } | null>(
    null,
  );

  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const suggestedSlug = collection.title
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 64);

  useEffect(() => {
    if (preview === null) return;

    return () => URL.revokeObjectURL(preview.url);
  }, [preview]);

  async function prepare(form: HTMLFormElement) {
    const fields = new FormData(form);
    setBusy(true);
    setError("");
    setPreview(null);

    try {
      const result = await rpc.call("packExport", {
        ...workspace,
        collectionId: collection.id,
        publisher: String(fields.get("publisher") ?? ""),
        slug: String(fields.get("slug") ?? ""),
        version: String(fields.get("version") ?? ""),
        license: String(fields.get("license") ?? ""),
      });

      const pack = readPack(result.text);
      const url = URL.createObjectURL(new Blob([result.text], { type: "application/json" }));
      setPreview({ url, pack, digest: result.digest });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sd-notice">
      <h3>Export {collection.title}</h3>
      <p>Exports linked skills and saved prompts. Project references stay in their workspace.</p>
      <form
        className="sd-form"
        onSubmit={(event) => {
          event.preventDefault();
          void prepare(event.currentTarget);
        }}
      >
        <label>
          Publisher ID
          <input name="publisher" required pattern="[a-z0-9]+(-[a-z0-9]+)*" maxLength={64} />
        </label>
        <label>
          Pack ID
          <input
            name="slug"
            required
            defaultValue={suggestedSlug}
            pattern="[a-z0-9]+(-[a-z0-9]+)*"
            maxLength={64}
          />
        </label>
        <label>
          Version
          <input name="version" required defaultValue="1.0.0" maxLength={40} />
        </label>
        <label>
          License
          <input name="license" required maxLength={160} />
        </label>
        <div className="sd-actions">
          <button type="submit" className="sd-button sd-primary" disabled={busy}>
            {busy ? "Preparing…" : "Preview export"}
          </button>
          <button type="button" className="sd-button" onClick={onClose} disabled={busy}>
            Close export
          </button>
        </div>
      </form>
      {error && (
        <p className="sd-notice" role="alert">
          {error}
        </p>
      )}
      {preview && (
        <>
          <PackContents pack={preview.pack} inspect={false} />
          <p className="sd-muted">
            SHA-256 <code>{preview.digest}</code>
          </p>
          <a
            className="sd-button sd-primary"
            href={preview.url}
            download={`${preview.pack.slug}.omnyoskillpack`}
          >
            Download pack
          </a>
        </>
      )}
    </div>
  );
}
