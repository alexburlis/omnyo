import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useRpc } from "@omnyo/plugin-sdk/app";
import type { z } from "zod";
import { curatedRpc, searchCurated, type CuratedEntry } from "./curated-contract";
import type { Workspace } from "./library-contract";
import type { InstalledSource } from "./library-view";

type Review = z.infer<(typeof curatedRpc)["catalogReview"]["output"]>;

type Receipt = z.infer<(typeof curatedRpc)["catalogConfirm"]["output"]>;

export type InstalledChoice = { source: InstalledSource; disabledReason: string | null };

export function CuratedBrowser({
  initialQuery = "",
  workspace,
  installed = [],
  chooseInstalled,
  chooseCurated,
  onInstalled,
  onBusy,
  onReviewStart,
  close,
}: {
  initialQuery?: string;
  workspace: Workspace | null;
  installed?: InstalledChoice[];
  chooseInstalled?(source: InstalledSource): void;
  chooseCurated?(entry: CuratedEntry, generation: string): Promise<void>;
  onInstalled(receipt: Receipt, entry: CuratedEntry, review: Review): Promise<void> | void;
  onReviewStart?(): void;
  onBusy?(busy: boolean): void;
  close?(): void;
}) {
  const rpc = useRpc<typeof curatedRpc>();

  const [catalog, setCatalog] = useState<z.infer<
    (typeof curatedRpc)["catalogGet"]["output"]
  > | null>(null);

  const [catalogError, setCatalogError] = useState("");
  const [reload, setReload] = useState(0);
  const [query, setQuery] = useState(initialQuery);
  const [highlight, setHighlight] = useState(0);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [review, setReview] = useState<{ entry: CuratedEntry; value: Review } | null>(null);
  const mounted = useRef(true);
  const request = useRef(0);
  const running = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const resultList = useRef<HTMLDivElement>(null);
  const searchId = useId();
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const selectedId = useRef<string | null>(null);
  const workspaceKey = JSON.stringify(workspace);

  useEffect(() => {
    mounted.current = true;

    return () => {
      mounted.current = false;
      request.current += 1;
    };
  }, []);

  useEffect(() => {
    let active = true;
    setCatalogError("");
    void rpc
      .call("catalogGet", {})
      .then((value) => {
        if (active) {
          setCatalog(value);

          if (selectedId.current) {
            const index = searchCurated(value.entries, query).findIndex(
              (entry) => entry.id === selectedId.current,
            );

            if (index >= 0) setHighlight(installedMatches.length + index);
          }
        }
      })
      .catch((cause) => {
        if (active)
          setCatalogError(cause instanceof Error ? cause.message : "The catalog could not load.");
      });

    return () => {
      active = false;
    };
  }, [rpc, reload]);

  useEffect(() => {
    request.current += 1;
    setReview(null);
    setPending(null);
    setError("");
  }, [workspaceKey]);

  const matches = useMemo(
    () =>
      searchCurated(catalog?.entries ?? [], query).filter(
        (entry) => !installed.some(({ source }) => source.registrySkillId === entry.id),
      ),
    [catalog, query, installed],
  );

  const installedMatches = useMemo(() => {
    const needle = query.trim().toLowerCase();

    return installed
      .filter(({ source }) =>
        `${source.name} ${source.description ?? ""} ${source.filePath}`
          .toLowerCase()
          .includes(needle),
      )
      .slice(0, 30);
  }, [installed, query]);

  const count = installedMatches.length + matches.length;
  const highlighted = Math.min(highlight, Math.max(0, count - 1));

  useEffect(() => {
    if (review) reviewHeading.current?.focus();
  }, [review]);

  function focusSearch() {
    requestAnimationFrame(() => input.current?.focus());
  }

  function back() {
    request.current += 1;
    setReview(null);
    setError("");
    focusSearch();
  }

  async function activate(entry: CuratedEntry, install: boolean) {
    if (!catalog || running.current || (install && !workspace)) return;
    selectedId.current = entry.id;
    running.current = true;
    const ticket = ++request.current;
    setPending(entry.id);
    setError("");
    setStatus(
      install ? `Preparing ${entry.name} for review…` : `Preparing ${entry.name} for one-time use…`,
    );

    try {
      if (!install && chooseCurated && entry.useOnce) {
        await chooseCurated(entry, catalog.generation);
      } else if (workspace) {
        onReviewStart?.();

        const value = await rpc.call("catalogReview", {
          id: entry.id,
          generation: catalog.generation,
          ...workspace,
        });

        if (mounted.current && ticket === request.current) {
          setStatus("");
          setReview({ entry, value });
        }
      }
    } catch (cause) {
      if (mounted.current && ticket === request.current) {
        const message =
          cause instanceof Error ? cause.message : "The skill could not load. Try again.";

        setError(message);
        setStatus("");

        if (/stale|catalog.*updated|generation/iu.test(message)) {
          setReload((value) => value + 1);
          setStatus("The catalog was updated. Review the results and choose the skill again.");
        }
      }
    } finally {
      running.current = false;

      if (mounted.current && ticket === request.current) {
        setPending(null);
      }
    }
  }

  async function confirm() {
    if (
      !review ||
      running.current ||
      JSON.stringify({
        projectId: review.value.projectId,
        environmentId: review.value.environmentId,
      }) !== workspaceKey
    )
      return;
    running.current = true;
    const ticket = ++request.current;
    setPending(review.entry.id);
    setError("");
    onBusy?.(true);

    try {
      const receipt = await rpc.call("catalogConfirm", {
        reviewId: review.value.reviewId,
        digest: review.value.digest,
      });

      if (mounted.current && ticket === request.current) {
        await onInstalled(receipt, review.entry, review.value);
        setReview(null);
        setStatus(`Installed ${review.entry.name}.`);
      }
    } catch (cause) {
      if (mounted.current && ticket === request.current)
        setError(
          cause instanceof Error ? cause.message : "The skill could not install. Try again.",
        );
    } finally {
      running.current = false;
      onBusy?.(false);

      if (mounted.current) setPending(null);
    }
  }

  return (
    <div
      className="sd-curated"
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;

        if (
          (event.key === "ArrowDown" || event.key === "ArrowUp") &&
          event.target instanceof HTMLButtonElement &&
          event.target.hasAttribute("data-curated-primary")
        ) {
          event.preventDefault();
          event.stopPropagation();

          const buttons = Array.from(
            resultList.current?.querySelectorAll<HTMLButtonElement>("[data-curated-primary]") ?? [],
          ).filter((button) => !button.disabled);

          const current = buttons.indexOf(event.target);
          buttons[
            (current + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length
          ]?.focus();
        }

        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();

          if (review) back();
          else close?.();
        }
      }}
    >
      {review ? (
        <>
          <button type="button" className="sd-button" onClick={back} disabled={pending !== null}>
            Back to results
          </button>
          <h2 ref={reviewHeading} tabIndex={-1}>
            Install {review.entry.name}
          </h2>
          <p>{review.entry.description}</p>
          <dl className="sd-meta">
            <dt>Publisher</dt>
            <dd>{review.entry.publisher}</dd>
            <dt>License</dt>
            <dd>{review.entry.license}</dd>
            <dt>Source</dt>
            <dd>
              <a href={review.entry.sourceUrl} target="_blank" rel="noreferrer">
                View source
              </a>
            </dd>
            <dt>Destination</dt>
            <dd>
              <code>{review.value.workspacePath}</code>
            </dd>
            <dt>SHA-256</dt>
            <dd>
              <code>{review.value.digest}</code>
            </dd>
          </dl>
          <div className="sd-pack-contents">
            <h3>Files to install</h3>
            {review.value.pack.skills.map((skill) => (
              <div key={skill.id}>
                <strong>{skill.id}</strong>
                {skill.files.map((file) => (
                  <details key={file.path}>
                    <summary>
                      <code>{file.path}</code>
                    </summary>
                    <pre className="sd-file-content">{file.content}</pre>
                  </details>
                ))}
              </div>
            ))}
          </div>
          <button
            className="sd-button sd-primary"
            type="button"
            disabled={pending !== null}
            onClick={() => void confirm()}
          >
            {pending ? "Installing…" : chooseCurated ? "Install and use" : "Install"}
          </button>
        </>
      ) : (
        <>
          <label htmlFor={searchId}>Search skills</label>
          <input
            id={searchId}
            ref={input}
            autoFocus
            type="search"
            className="sd-curated-search"
            placeholder="Search skills"
            value={query}
            aria-controls={`${searchId}-results`}
            aria-describedby={`${searchId}-status`}
            onChange={(event) => {
              setQuery(event.target.value);
              setHighlight(0);
              setStatus("");
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;

              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                event.stopPropagation();

                const next = count
                  ? (highlighted + (event.key === "ArrowDown" ? 1 : count - 1)) % count
                  : 0;

                setHighlight(next);

                const option =
                  resultList.current?.querySelectorAll<HTMLButtonElement>("[data-curated-primary]")[
                    next
                  ];

                option?.scrollIntoView({ block: "nearest" });
                setStatus(option?.getAttribute("aria-label") ?? "");
              } else if (event.key === "Enter") {
                event.preventDefault();
                event.stopPropagation();
                resultList.current
                  ?.querySelectorAll<HTMLButtonElement>("[data-curated-primary]")
                  [highlighted]?.click();
              }
            }}
          />
          {!workspace && (
            <p className="sd-muted">
              Choose a workspace in the composer or Skill Library to install skills.
            </p>
          )}
          <div id={`${searchId}-results`} ref={resultList} className="sd-curated-results">
            {installedMatches.length > 0 && <h3>Installed</h3>}
            {installedMatches.map(({ source, disabledReason }, index) => (
              <div
                className="sd-curated-row"
                key={source.id}
                data-highlighted={index === highlighted}
              >
                <button
                  type="button"
                  data-curated-primary
                  className="sd-curated-primary"
                  disabled={pending !== null || disabledReason !== null}
                  onFocus={() => setHighlight(index)}
                  aria-label={`Insert ${source.name}`}
                  onClick={() => chooseInstalled?.(source)}
                >
                  <strong>{source.name}</strong>
                  <span>{source.description}</span>
                  <small>
                    Installed · {source.provider ?? "Shared"} · {source.scope}
                  </small>
                  {disabledReason && <small>{disabledReason}</small>}
                </button>
              </div>
            ))}
            <h3>Curated</h3>
            {!catalog && !catalogError && <p role="status">Loading curated skills…</p>}
            {catalogError && (
              <div role="alert">
                <p>{catalogError}</p>
                <button
                  type="button"
                  className="sd-button"
                  onClick={() => setReload((value) => value + 1)}
                >
                  Retry
                </button>
              </div>
            )}
            {matches.map((entry, index) => (
              <div
                className="sd-curated-row"
                key={entry.id}
                data-highlighted={index + installedMatches.length === highlighted}
              >
                <button
                  type="button"
                  data-curated-primary
                  className="sd-curated-primary"
                  disabled={pending !== null || ((!entry.useOnce || !chooseCurated) && !workspace)}
                  onFocus={() => setHighlight(index + installedMatches.length)}
                  aria-label={
                    chooseCurated && entry.useOnce
                      ? `Use ${entry.name} once`
                      : `Review install of ${entry.name}`
                  }
                  onClick={() => void activate(entry, !chooseCurated || !entry.useOnce)}
                >
                  <strong>{entry.name}</strong>
                  <span>{entry.description}</span>
                  <small>
                    {entry.publisher} ·{" "}
                    {chooseCurated && entry.useOnce ? "Use once" : "Requires installation"}
                    {pending === entry.id ? " · Preparing…" : ""}
                  </small>
                </button>
                {chooseCurated && (
                  <button
                    type="button"
                    className="sd-button sd-curated-install"
                    disabled={!workspace || pending !== null}
                    aria-label={`Install ${entry.name}`}
                    title={
                      workspace ? `Install ${entry.name}` : "Choose a workspace to install skills"
                    }
                    onClick={() => void activate(entry, true)}
                  >
                    Install…
                  </button>
                )}
              </div>
            ))}
            {catalog && count === 0 && <p>No matching skills.</p>}
          </div>
        </>
      )}
      {error && (
        <p role="alert" className="sd-notice">
          {error}
        </p>
      )}
      <p id={`${searchId}-status`} role="status" aria-live="polite" className="sd-muted">
        {status || (!review && catalog ? `${count} skills found.` : "")}
      </p>
    </div>
  );
}
