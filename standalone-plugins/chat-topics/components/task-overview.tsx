import { useState } from "react";
import { experimental_Icon as Icon } from "@omnyo/plugin-sdk/app";
import {
  memoryLabel,
  processName,
  sparklineSegments,
  type UsageSample,
  type HostUsage,
} from "../lib/task-usage.ts";
import type { TaskUsage } from "../lib/use-task-usage.ts";

function percent(value: number | null | undefined) {
  return value == null ? "—" : `${Math.round(value)}%`;
}

function Metric({
  label,
  value,
  samples,
  title,
}: {
  label: string;
  value: string;
  samples: readonly (number | null)[];
  title?: string;
}) {
  return (
    <div className="ct-task-metric" title={title}>
      <span>{label}</span>
      <strong>{value}</strong>
      <svg className="ct-task-sparkline" viewBox="0 0 74 24" preserveAspectRatio="none" aria-hidden>
        {sparklineSegments(samples).map((points, index) =>
          points.includes(" ") ? (
            <polyline key={index} points={points} />
          ) : (
            <circle key={index} cx={points.split(",")[0]} cy={points.split(",")[1]} r="1.5" />
          ),
        )}
      </svg>
    </div>
  );
}

const NO_HISTORY: readonly UsageSample[] = [];

function ChatTasks({
  thread,
  title,
  query,
  supported,
}: {
  thread: HostUsage["threads"][number];
  title: string;
  query: string;
  supported: boolean;
}) {
  const titleMatches = title.toLowerCase().includes(query);

  const tasks = [...(thread.tasks ?? [])]
    .filter(
      (task) =>
        titleMatches ||
        processName(task.name).toLowerCase().includes(query) ||
        String(task.pid).includes(query),
    )
    .sort((a, b) => a.pid - b.pid);

  if (!titleMatches && tasks.length === 0) return null;

  return (
    <details className="ct-task-chat" open={query && !titleMatches ? true : undefined}>
      <summary
        className="ct-task-chat-title"
        aria-label={`${title}, CPU ${supported ? percent(thread.cpuPercent) : "unavailable"}, RAM ${supported ? memoryLabel(thread.memoryBytes) : "unavailable"}`}
      >
        <span className="ct-task-name">
          <Icon name="ChevronRight" aria-hidden className="ct-task-chevron" />
          <strong title={title}>{title}</strong>
        </span>
        <span aria-label={`CPU ${percent(thread.cpuPercent)}`}>
          {supported ? percent(thread.cpuPercent) : "—"}
        </span>
        <span aria-label={`RAM ${memoryLabel(thread.memoryBytes)}`}>
          {supported ? memoryLabel(thread.memoryBytes) : "—"}
        </span>
      </summary>
      {tasks.length ? (
        tasks.map((task) => (
          <div className="ct-task-process" key={task.pid}>
            <span
              className="ct-task-process-name"
              title={`${processName(task.name)} · PID ${task.pid}`}
            >
              {processName(task.name)} <small>{task.pid}</small>
            </span>
            <span>{supported ? percent(task.cpuPercent) : "—"}</span>
            <span>{supported ? memoryLabel(task.memoryBytes) : "—"}</span>
          </div>
        ))
      ) : (
        <p className="ct-task-coverage">
          {thread.tasks ? "No processes recorded." : "Process details unavailable."}
        </p>
      )}
    </details>
  );
}

export function TaskOverview({
  usage,
  onClose,
  enabled,
  onToggle,
}: {
  usage: TaskUsage;
  onClose: () => void;
  enabled: boolean;
  onToggle: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const query = search.trim().toLowerCase();
  const hosts = usage.kind === "ready" ? usage.snapshot.hosts : [];
  const host = hosts.find((item) => item.hostId === selected) ?? hosts[0];
  const system = host?.system;

  const samples =
    (usage.kind === "ready" && host ? usage.history.get(host.hostId) : undefined) ?? NO_HISTORY;

  const threads =
    usage.kind === "ready" && host
      ? host.threads
          .map((thread) => ({
            thread,
            title: usage.titles.get(thread.threadId) ?? `Chat ${thread.threadId}`,
          }))
          .sort(
            (a, b) =>
              a.title.localeCompare(b.title) || a.thread.threadId.localeCompare(b.thread.threadId),
          )
      : [];

  const supported = host?.coverage === "complete" || host?.coverage === "partial";

  const stateMessage =
    usage.kind === "failed"
      ? "Couldn’t read usage. Retrying…"
      : usage.kind !== "ready"
        ? "Reading usage…"
        : !host
          ? "No connected machines."
          : host.coverage === "failed"
            ? "Machine readings unavailable. Retrying…"
            : host.coverage === "unsupported"
              ? "Per-chat usage is unavailable on this machine."
              : host.coverage === "partial" && !threads.length
                ? "No chat processes could be measured."
                : !threads.length
                  ? "No chat-owned processes."
                  : null;

  return (
    <>
      <header className="ct-task-overview-title">
        <strong>Task Manager</strong>
        {host && (
          <select
            aria-label="Machine"
            value={host.hostId}
            onChange={(event) => {
              setSelected(event.currentTarget.value);
              setSearch("");
            }}
          >
            {hosts.map((item) => (
              <option key={item.hostId} value={item.hostId}>
                {item.hostName || item.hostId}
              </option>
            ))}
          </select>
        )}
        <button type="button" aria-label="Close task overview" onClick={onClose}>
          <Icon name="X" aria-hidden className="size-4" />
        </button>
      </header>
      <div className="ct-task-metrics" role="group" aria-label="Machine usage">
        <Metric
          label="CPU"
          value={percent(system?.cpuPercent)}
          samples={samples.map((sample) => sample.cpu)}
        />
        <Metric
          label="GPU"
          value={percent(system?.gpuPercent)}
          samples={samples.map((sample) => sample.gpu)}
        />
        <Metric
          label="RAM"
          value={system?.memoryUsedBytes == null ? "—" : memoryLabel(system.memoryUsedBytes)}
          samples={samples.map((sample) => sample.memory)}
          title={
            system?.memoryTotalBytes
              ? `${memoryLabel(system.memoryTotalBytes)} total RAM`
              : undefined
          }
        />
      </div>
      <label className="ct-task-search">
        <Icon name="Search" aria-hidden className="size-4" />
        <input
          type="search"
          aria-label="Find chats or processes"
          placeholder="Find chat, process or PID"
          value={search}
          disabled={!threads.length}
          onChange={(event) => setSearch(event.currentTarget.value)}
        />
      </label>
      <div className="ct-task-process-heading">
        <span>Chats{threads.length ? ` · ${threads.length}` : ""}</span>
        <span>CPU</span>
        <span>RAM</span>
      </div>
      <div
        className="ct-task-processes"
        key={host?.hostId}
        role="region"
        tabIndex={0}
        aria-label="Chat-owned processes"
      >
        {stateMessage ? (
          <p className="ct-task-empty" role="status">
            {stateMessage}
          </p>
        ) : (
          <>
            {threads.map(({ thread, title }) => (
              <ChatTasks
                key={thread.threadId}
                thread={thread}
                title={title}
                query={query}
                supported={supported}
              />
            ))}
            {query && (
              <p className="ct-task-empty ct-task-no-match" role="status">
                No matching chats or processes.
              </p>
            )}
            {host?.coverage === "partial" && (
              <p className="ct-task-coverage">Some process readings are unavailable.</p>
            )}
          </>
        )}
      </div>
      <label className="ct-task-preference">
        <span>Show usage in sidebar</span>
        <input type="checkbox" checked={enabled} onChange={onToggle} />
      </label>
    </>
  );
}
