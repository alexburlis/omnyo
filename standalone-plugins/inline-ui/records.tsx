import { useEffect, useState } from "react";
import {
  Markdown,
  experimental_FileLink as FileLink,
  useSdk,
  type ExperimentalLiveFileTarget,
  type ExperimentalFileLocation,
  type PluginMessageDirectiveProps,
} from "@omnyo/plugin-sdk/app";
import { readTone } from "./block-fields";
import { ReadableFallback } from "./invalid";
import { parseFileCard, readStatusTable, webAddress } from "./record-fields";
import "./records.css";
import { PlanAction } from "./plan-action";

const wrapLength = 24;

export function StatusTable(props: PluginMessageDirectiveProps) {
  const table = readStatusTable(props.attributes);
  const labels = table.ok ? table.attributes.labels?.split("|") : undefined;
  const values = table.ok ? table.attributes.values?.split("|") : undefined;

  if (!table.ok || !labels || !values) {
    return (
      <ReadableFallback
        attributes={table.attributes}
        reason={table.ok ? "rows need labels and values" : table.reason}
        source={props.source}
      />
    );
  }

  const { attributes } = table;
  const label = attributes.label;
  const columns = attributes.columns?.split("|");
  const tones = attributes.tones?.split("|");
  const details = attributes.details?.split("|");
  const note = attributes.note;
  const detailColumn = columns?.length === 3;

  return (
    <figure className="omnyo-inline-status">
      {label ? (
        <figcaption className="omnyo-inline-status__title">{label.trim()}</figcaption>
      ) : null}
      <table className="omnyo-inline-status__table">
        {columns ? (
          <thead>
            <tr>
              <th scope="col">{columns[0].trim()}</th>
              <th
                scope="col"
                data-wrap={columns[1].trim().length > wrapLength ? "true" : undefined}
              >
                {columns[1].trim()}
              </th>
              {detailColumn ? (
                <th scope="col" className="omnyo-inline-status__detail-head">
                  {columns[2].trim()}
                </th>
              ) : null}
            </tr>
          </thead>
        ) : null}
        <tbody>
          {labels.map((rowLabel, index) => (
            <tr key={index}>
              <th scope="row">
                <span className="omnyo-inline-status__label">{rowLabel.trim()}</span>
                {!detailColumn && details?.[index]?.trim() ? (
                  <span className="omnyo-inline-status__detail">{details[index].trim()}</span>
                ) : null}
              </th>
              <td
                data-tone={readTone(tones?.[index])}
                data-wrap={values[index].trim().length > wrapLength ? "true" : undefined}
              >
                <span className="omnyo-inline-status__value">{values[index].trim()}</span>
              </td>
              {detailColumn ? (
                <td className="omnyo-inline-status__detail-cell">{details?.[index]?.trim()}</td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
      {note?.trim() ? (
        <figcaption className="omnyo-inline-status__note">{note.trim()}</figcaption>
      ) : null}
    </figure>
  );
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}[\]()#+\-.!|~&]/gu, "\\$&");
}

function FileGlyph({ kind }: { kind: string }) {
  return (
    <svg
      className="omnyo-inline-file__glyph"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {kind === "link" ? (
        <>
          <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
          <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
        </>
      ) : (
        <>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <path d="M14 2v6h6" />
          {kind === "download" ? (
            <>
              <path d="M12 11v6" />
              <path d="m9 14 3 3 3-3" />
            </>
          ) : (
            <path d="M8 13h8M8 17h5" />
          )}
        </>
      )}
    </svg>
  );
}

type LocalFile =
  | { kind: "loading" }
  | { kind: "found"; target: ExperimentalLiveFileTarget }
  | { kind: "missing"; path: string }
  | { kind: "unavailable" };

const absolutePath = /^(?:\/|[A-Za-z]:[\\/])/u;

function workspacePath(root: string, path: string) {
  const separator = /^(?:[A-Za-z]:[\\/]|\\\\)/u.test(root) ? "\\" : "/";

  return `${root.replace(/[\\/]+$/u, "")}${separator}${path}`;
}

function useLocalFile(path: string, threadId: string): LocalFile {
  const sdk = useSdk();
  const key = `${threadId}\n${path}`;
  const [state, setState] = useState<{ key: string; file: LocalFile } | null>(null);

  useEffect(() => {
    let active = true;
    let latest = 0;

    let located:
      | Promise<{ hostId: string; checked: string; target: ExperimentalLiveFileTarget }>
      | undefined;

    async function locate() {
      const thread = await sdk.threads.get({ threadId });

      if (!thread.environmentId) throw new Error("This message has no workspace.");
      const environment = await sdk.environments.get({ environmentId: thread.environmentId });

      if (absolutePath.test(path))
        return {
          hostId: environment.hostId,
          checked: path,
          target: { kind: "host" as const, hostId: environment.hostId, path },
        };

      if (environment.path === null) throw new Error("The workspace is not ready.");

      return {
        hostId: environment.hostId,
        checked: workspacePath(environment.path, path),
        target: { kind: "workspace" as const, environmentId: thread.environmentId, path },
      };
    }

    async function check() {
      const attempt = ++latest;

      try {
        located ??= locate();
        const { hostId, checked, target } = await located;
        const { existence } = await sdk.hosts.pathsExist({ hostId, paths: [checked] });
        const exists = existence[checked];

        if (exists === undefined) throw new Error("The machine did not report the file.");

        if (active && attempt === latest)
          setState({
            key,
            file: exists ? { kind: "found", target } : { kind: "missing", path: checked },
          });
      } catch {
        located = undefined;

        if (active && attempt === latest) setState({ key, file: { kind: "unavailable" } });
      }
    }

    const visible = () => {
      if (document.visibilityState === "visible") void check();
    };

    void check();
    window.addEventListener("focus", visible);
    document.addEventListener("visibilitychange", visible);

    return () => {
      active = false;
      window.removeEventListener("focus", visible);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [key, path, sdk, threadId]);

  return state?.key === key ? state.file : { kind: "loading" };
}

function LocalFileCard({
  href,
  title,
  meta,
  kind,
  threadId,
}: {
  href: string;
  title: string;
  meta: string | undefined;
  kind: string;
  threadId: string;
}) {
  const suffix = href.match(/(?::([1-9][0-9]*)|#L([1-9][0-9]*)(?:-L?([1-9][0-9]*))?)$/u);
  const path = (suffix ? href.slice(0, suffix.index) : href).replace(/^\.\//u, "");
  const file = useLocalFile(path, threadId);

  const location: ExperimentalFileLocation | null = suffix
    ? suffix[3]
      ? { kind: "range", startLine: Number(suffix[2]), endLine: Number(suffix[3]) }
      : { kind: "line", line: Number(suffix[1] ?? suffix[2]), column: null }
    : null;

  return (
    <div className="omnyo-inline-file" data-kind={kind} data-state={file.kind}>
      <FileGlyph kind={kind} />
      <div className="omnyo-inline-file__body">
        {file.kind === "found" ? (
          <FileLink className="omnyo-inline-file__link" target={file.target} location={location}>
            {title}
          </FileLink>
        ) : (
          <span
            className="omnyo-inline-file__link"
            aria-disabled="true"
            title={file.kind === "loading" ? "Loading file location…" : undefined}
          >
            {title}
            {file.kind === "unavailable" ? " — File preview unavailable" : ""}
          </span>
        )}
        {meta?.trim() ? <span className="omnyo-inline-file__meta">{meta.trim()}</span> : null}
        {file.kind === "missing" ? (
          <span className="omnyo-inline-file__missing" role="status">
            File not found: {file.path}
          </span>
        ) : null}
      </div>
      {file.kind === "found" &&
      /\.(?:md|markdown)(?::[1-9][0-9]*|#L[1-9][0-9]*(?:-L?[1-9][0-9]*)?)?$/iu.test(href) ? (
        <PlanAction key={`${threadId}\n${href}`} href={href} sourceThreadId={threadId} />
      ) : null}
    </div>
  );
}

export function FileCard(props: PluginMessageDirectiveProps) {
  const parsed = parseFileCard(props.attributes);

  if (!parsed.ok) {
    return (
      <ReadableFallback
        attributes={parsed.attributes}
        reason={parsed.reason}
        source={props.source}
      />
    );
  }

  const { attributes } = parsed;
  const title = attributes.title;
  const href = attributes.href?.trim();
  const meta = attributes.meta;
  const kind = attributes.kind ?? "file";

  if (title === undefined || !href) {
    return (
      <ReadableFallback
        attributes={attributes}
        reason="the path or link is missing"
        source={props.source}
      />
    );
  }

  if (!webAddress.test(href))
    return (
      <LocalFileCard
        href={href}
        title={title.trim()}
        meta={meta}
        kind={kind}
        threadId={props.message.threadId}
      />
    );

  return (
    <div className="omnyo-inline-file" data-kind={kind}>
      <FileGlyph kind={kind} />
      <div className="omnyo-inline-file__body">
        <Markdown
          className="omnyo-inline-file__link"
          content={`[${escapeMarkdown(title.trim())}](<${href}>)`}
        />
        {meta?.trim() ? <span className="omnyo-inline-file__meta">{meta.trim()}</span> : null}
      </div>
    </div>
  );
}
