import { useEffect, useMemo, useRef, useState } from "react";
import { usePluginResource } from "@omnyo/plugin-sdk/app";
import { inboxPageSize, type InboxQuery, type Route } from "../../contract";
import type { InboxClient } from "./client";
import { ModelDefaultsBar, modelLabel, type ModelPickerComponent } from "./models";
import { ProjectSetup } from "./project-setup";
import { RouteEditor } from "./route-editor";
import { IssueCard } from "./issue-card";
import { Investigations } from "./investigations";
import { PolicyControl } from "./policy-control";
import { operationKey } from "./operations";
import { dateLabel, projectInbox, repositoryCount } from "./projection";
import { isActiveRun } from "../run-state";
import * as Dialog from "@radix-ui/react-dialog";
import "./style.css";

type ViewProps = {
  snapshot: ReturnType<InboxClient["getSnapshot"]>;
  client: Pick<
    InboxClient,
    | "addProject"
    | "catalog"
    | "investigate"
    | "listInbox"
    | "loadTargets"
    | "repositories"
    | "resourceId"
    | "resumeBatch"
    | "retry"
    | "saveModel"
    | "savePolicy"
    | "saveRoute"
    | "solveAll"
    | "stop"
    | "stopBatch"
    | "sync"
    | "toggleRoute"
  >;
  onOpenThread: (id: string) => void;
  ModelPicker: ModelPickerComponent;
};

export function SentryView({ snapshot, client, onOpenThread, ModelPicker }: ViewProps) {
  const { status, targets, targetsLoaded, targetsError, error, refreshing } = snapshot;

  const pending = (key: string) => snapshot.pending.includes(key);
  const syncing = pending(operationKey.sync) || Boolean(status?.syncing);
  const [tab, setTab] = useState("Inbox");

  const [editor, setEditor] = useState<
    { kind: "closed" } | { kind: "new" } | { kind: "edit"; route: Route }
  >({ kind: "closed" });

  const [selected, setSelected] = useState("");
  const [selectedProject, setSelectedProject] = useState("");
  const [search, setSearch] = useState("");
  const [issueUrl, setIssueUrl] = useState("");
  const [routeId, setRouteId] = useState("");
  const [severity, setSeverity] = useState<InboxQuery["severity"]>("");
  const [sort, setSort] = useState<InboxQuery["sort"]>("recent");
  const [offset, setOffset] = useState(0);

  const editorTrigger = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (editor.kind === "closed") editorTrigger.current?.focus();
  }, [editor]);

  const loadTargets = () => client.loadTargets(true);

  const closeEditor = () =>
    setEditor((current) => (current === editor ? { kind: "closed" } : current));

  const openEditor = (route: Route | null) => {
    editorTrigger.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setEditor(route ? { kind: "edit", route } : { kind: "new" });
    loadTargets();
  };

  const {
    models,
    routes,
    scopedRoutes,
    manualRoutes,
    selectedRoute,
    runs,
    active,
    incidents: previewIncidents,
    freshness,
    projectIds,
    focusedProject,
    missingProject,
    projectName,
    issueCount,
  } = projectInbox({
    status,
    targets,
    targetsLoaded,
    selectedProject,
    selected,
    search,
    severity,
    sort,
    routeId,
  });

  const filtered = Boolean(search || selected || selectedProject || severity);
  const preview = status?.incidents;
  const totalOpen = status?.badge.count ?? 0;

  const needsPage = Boolean(
    preview && (offset > 0 || (preview.length < totalOpen && (filtered || sort !== "recent"))),
  );

  const inboxQuery = useMemo<InboxQuery>(
    () => ({
      projectId: selectedProject || null,
      routeId: selected || null,
      search,
      severity,
      sort,
      offset,
    }),
    [selectedProject, selected, search, severity, sort, offset],
  );

  const listInbox = client.listInbox;

  const pageResource = usePluginResource({
    key: [
      "sentry",
      "inbox",
      client.resourceId,
      selectedProject,
      selected,
      search,
      severity,
      sort,
      offset,
    ],
    enabled: tab === "Inbox" && needsPage,
    staleTime: 0,
    load: () => listInbox(inboxQuery),
  });

  const previousPreview = useRef(preview);

  useEffect(() => {
    if (previousPreview.current === preview) return;
    previousPreview.current = preview;

    if (needsPage && tab === "Inbox") pageResource.invalidate();
  }, [preview]);

  const incidents = needsPage ? (pageResource.data?.incidents ?? []) : previewIncidents;
  const total = needsPage ? pageResource.data?.total : filtered ? incidents.length : totalOpen;
  const pageError = needsPage && pageResource.status === "error";
  const pagePending = needsPage && !pageResource.data && !pageError;
  const hasNextPage = total !== undefined && offset + incidents.length < total;

  const clearFilters = () => {
    setSearch("");
    setSelected("");
    setSelectedProject("");
    setSeverity("");
    setOffset(0);
  };

  const chooseProject = (id: string) => {
    setSelectedProject(id);
    setSelected("");
    setRouteId("");
    setOffset(0);
  };

  const projectAction = (projectId: string) => {
    const batch = status?.batches?.find(
      (batch) => batch.projectId === projectId && !["complete", "cancelled"].includes(batch.state),
    );

    const starting = pending(operationKey.batch(projectId));
    const watching = routes.some((route) => route.projectId === projectId && route.enabled);
    const projectMissing = missingProject(projectId);

    return batch ? (
      <div className="sentry-batch-actions">
        <span className="sentry-state">
          {batch.state === "stopping"
            ? "Stopping…"
            : batch.state === "preparing"
              ? "Reading issues…"
              : batch.state === "planning"
                ? "Grouping issues"
                : batch.state === "waiting"
                  ? "Solving packages"
                  : batch.state === "summarizing"
                    ? "Writing summary"
                    : "Needs attention"}
        </span>
        {batch.threadId && (
          <button onClick={() => onOpenThread(batch.threadId!)}>Open project solver ↗</button>
        )}
        {(batch.reason || batch.state === "failed") && (
          <button
            disabled={pending(operationKey.batchRun(batch.id))}
            onClick={() => client.resumeBatch(batch.id)}
          >
            Resume
          </button>
        )}
        <button
          disabled={pending(operationKey.batchRun(batch.id))}
          onClick={() => client.stopBatch(batch.id)}
        >
          Stop
        </button>
      </div>
    ) : (
      <div className="sentry-project-action">
        <button
          className="sentry-solve"
          disabled={starting || projectMissing || !status?.connected || !watching}
          aria-busy={starting}
          aria-label={"Solve all for " + projectName(projectId)}
          title={"Solve all with " + modelLabel(models.coordinator)}
          onClick={() => client.solveAll(projectId)}
        >
          {starting ? "Starting…" : "Solve all"}
          <span className="sentry-effort">{models.coordinator.reasoningLevel} effort</span>
        </button>
        {status?.connected && !projectMissing && !watching && (
          <p className="sentry-muted">Watch a repository in Projects to use Solve all.</p>
        )}
      </div>
    );
  };

  return (
    <main className="sentry-panel">
      <header className="sentry-heading sentry-topbar">
        <h1 className="sentry-sr-only">Sentry issues</h1>
        <span className="sentry-sync-line">
          {status && freshness !== "unconfigured" ? (
            <span className={"sentry-health sentry-health-" + freshness}>
              {!status.badge.lastSyncedAt
                ? "Not synced yet"
                : (freshness === "live"
                    ? "Synced "
                    : freshness === "stale"
                      ? "Sync is behind · last synced "
                      : "Partly synced · last synced ") + dateLabel(status.badge.lastSyncedAt)}
            </span>
          ) : null}
          <span role="status" aria-label="Inbox refresh" className="sentry-refresh-status">
            {status && refreshing ? "Refreshing…" : ""}
          </span>
        </span>
        <div className="sentry-actions">
          <button disabled={syncing} aria-busy={syncing} onClick={client.sync}>
            {syncing ? "Syncing…" : "Sync now"}
          </button>
          <button className="sentry-primary" onClick={() => openEditor(null)}>
            Add project
          </button>
        </div>
      </header>
      {error && (
        <p role="alert" className="sentry-error">
          {error}
        </p>
      )}
      {!status && !error && <p role="status">Loading Sentry…</p>}
      {status && !status.connected && (
        <p className="sentry-notice">Connect Sentry in plugin settings</p>
      )}
      {status?.lastError && (
        <p role="alert" className="sentry-error">
          Issue sync needs attention: {status.lastError}. The last known inbox is retained.
        </p>
      )}
      {status && (
        <nav className="sentry-tabs" aria-label="Sentry views">
          {["Inbox", "Investigations", "Projects"].map((name) => (
            <button
              key={name}
              aria-label={name}
              aria-pressed={tab === name}
              onClick={() => setTab(name)}
            >
              {name}
              {name === "Inbox" && <span>{status.badge.count}</span>}
              {name === "Investigations" && active > 0 && <span>{active}</span>}
            </button>
          ))}
        </nav>
      )}
      {status && routes.length > 0 && (
        <ModelDefaultsBar
          models={models}
          Picker={ModelPicker}
          pending={pending}
          onSave={client.saveModel}
        />
      )}
      {editor.kind === "new" && (
        <ProjectSetup
          organization={routes[0]?.organization ?? ""}
          projects={targets.projects}
          onCatalog={client.catalog}
          onRepositories={client.repositories}
          onSave={client.addProject}
          targetsError={targetsError}
          onRetryTargets={loadTargets}
          onClose={closeEditor}
          onInteractOutside={() => {
            editorTrigger.current = null;
          }}
        />
      )}
      {editor.kind === "edit" && (
        <Dialog.Root
          open
          modal={false}
          onOpenChange={(open) => {
            if (!open) closeEditor();
          }}
        >
          <Dialog.Content
            className="sentry-dialog"
            aria-describedby={undefined}
            onInteractOutside={() => {
              editorTrigger.current = null;
            }}
          >
            <Dialog.Title className="sentry-sr-only">Edit repository mapping</Dialog.Title>
            <RouteEditor
              key={editor.route.id}
              route={editor.route}
              targets={targets}
              projectMissing={missingProject(editor.route.projectId)}
              targetsError={targetsError}
              onRetryTargets={loadTargets}
              onSave={client.saveRoute}
              onClose={closeEditor}
            />
          </Dialog.Content>
        </Dialog.Root>
      )}
      <div className="sentry-workspace">
        {routes.length > 0 && (
          <nav className="sentry-project-nav" aria-label="Projects in Sentry">
            <span className="sentry-eyebrow">Workspace</span>
            <button aria-pressed={!selectedProject} onClick={() => chooseProject("")}>
              <span className="sentry-project-icon" aria-hidden="true">
                ◫
              </span>
              <span>All projects</span>
              <span className="sentry-count">{status?.badge.count ?? 0}</span>
            </button>
            <span className="sentry-nav-label">
              Projects <span>{projectIds.length}</span>
            </span>
            {projectIds.map((id) => (
              <button
                key={id}
                aria-pressed={selectedProject === id}
                onClick={() => chooseProject(id)}
              >
                <span className="sentry-project-icon" aria-hidden="true">
                  {projectName(id).slice(0, 1).toUpperCase()}
                </span>
                <span className="sentry-nav-name">{projectName(id)}</span>
                <span className="sentry-count">{issueCount(id)}</span>
              </button>
            ))}
          </nav>
        )}
        <div className="sentry-content">
          {routes.length > 0 && (
            <div className="sentry-scope-heading">
              <div>
                <h2>{selectedProject ? projectName(selectedProject) : "All projects"}</h2>
                <p className="sentry-muted">
                  {tab === "Projects"
                    ? repositoryCount(scopedRoutes) +
                      " repositories · " +
                      scopedRoutes.length +
                      " mappings"
                    : tab === "Investigations"
                      ? runs.length + " investigations"
                      : total === undefined
                        ? pageError
                          ? "Issue list unavailable"
                          : "Loading issues…"
                        : total + (total === 1 ? " issue in this view" : " issues in this view")}
                </p>
              </div>
              {tab === "Inbox" && focusedProject && projectAction(focusedProject)}
              {tab === "Inbox" && focusedProject && missingProject(focusedProject) && (
                <p role="alert" className="sentry-error">
                  This Omnyo project no longer exists. Move its repositories in Projects.
                </p>
              )}
              {tab === "Inbox" && !focusedProject && (
                <span className="sentry-scope-hint">
                  Choose a project to solve its issues together
                </span>
              )}
            </div>
          )}
          {tab === "Projects" && routes.length > 0 && (
            <label className="sentry-mobile-project sentry-project-select">
              <span className="sentry-sr-only">Filter Omnyo project</span>
              <select
                aria-label="Filter Omnyo project"
                value={selectedProject}
                onChange={(event) => chooseProject(event.target.value)}
              >
                <option value="">All projects</option>
                {projectIds.map((id) => (
                  <option key={id} value={id}>
                    {projectName(id)}
                  </option>
                ))}
              </select>
            </label>
          )}
          {(tab === "Inbox" || tab === "Investigations") && routes.length > 0 && (
            <div className="sentry-filterbar">
              {tab === "Inbox" && (
                <label className="sentry-grow">
                  <span className="sentry-sr-only">Search issues</span>
                  <input
                    type="search"
                    placeholder="Search issues…"
                    value={search}
                    maxLength={1000}
                    onChange={(event) => {
                      setSearch(event.target.value);
                      setOffset(0);
                    }}
                  />
                </label>
              )}
              <label className="sentry-mobile-project">
                <span className="sentry-sr-only">Filter Omnyo project</span>
                <select
                  aria-label="Filter Omnyo project"
                  value={selectedProject}
                  onChange={(event) => chooseProject(event.target.value)}
                >
                  <option value="">All projects</option>
                  {projectIds.map((id) => (
                    <option key={id} value={id}>
                      {projectName(id)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span className="sentry-sr-only">Filter route</span>
                <select
                  aria-label="Filter route"
                  value={selected}
                  onChange={(event) => {
                    setSelected(event.target.value);
                    setOffset(0);
                  }}
                >
                  <option value="">All repositories</option>
                  {scopedRoutes.map((route) => (
                    <option key={route.id} value={route.id}>
                      {route.name}
                    </option>
                  ))}
                </select>
              </label>
              {tab === "Inbox" && (
                <>
                  <label>
                    <span className="sentry-sr-only">Severity</span>
                    <select
                      aria-label="Severity"
                      value={severity}
                      onChange={(event) => {
                        const value = event.target.value;
                        setSeverity(value === "fatal" || value === "error" ? value : "");
                        setOffset(0);
                      }}
                    >
                      <option value="">All severities</option>
                      <option value="fatal">Fatal</option>
                      <option value="error">Error</option>
                    </select>
                  </label>
                  <label>
                    <span className="sentry-sr-only">Sort issues</span>
                    <select
                      aria-label="Sort issues"
                      value={sort}
                      onChange={(event) => {
                        const value = event.target.value;
                        setSort(value === "oldest" || value === "severity" ? value : "recent");
                        setOffset(0);
                      }}
                    >
                      <option value="recent">Last seen</option>
                      <option value="oldest">First seen</option>
                      <option value="severity">Severity</option>
                    </select>
                  </label>
                </>
              )}
              {filtered && (
                <button className="sentry-clear" onClick={clearFilters}>
                  Clear filters
                </button>
              )}
            </div>
          )}
          {tab === "Projects" && (
            <>
              {!routes.length && editor.kind === "closed" && (
                <div className="sentry-empty">
                  <h2>Watch your first project</h2>
                  <p>Connect a Sentry project to the repository where its fixes belong.</p>
                  <button className="sentry-primary" onClick={() => openEditor(null)}>
                    Add project
                  </button>
                </div>
              )}
              {status?.projectPolicies
                .filter((policy) => !selectedProject || policy.projectId === selectedProject)
                .map((policy) => (
                  <section
                    className="sentry-project"
                    key={policy.projectId}
                    aria-label={projectName(policy.projectId)}
                  >
                    <div className="sentry-heading">
                      <div>
                        <span className="sentry-eyebrow">Omnyo project</span>
                        <h2>{projectName(policy.projectId)}</h2>
                      </div>
                      <span className="sentry-state">
                        {policy.autoSolve ? "Auto solve on" : "Manual solving"}
                      </span>
                    </div>
                    {missingProject(policy.projectId) && (
                      <p role="alert" className="sentry-error">
                        This Omnyo project no longer exists. Pause each repository below, then
                        choose Edit to move it to a project.
                      </p>
                    )}
                    <div className="sentry-project-controls">{projectAction(policy.projectId)}</div>
                    <div className="sentry-route-list">
                      {routes
                        .filter((route) => route.projectId === policy.projectId)
                        .map((route) => (
                          <article className="sentry-route" key={route.id}>
                            <div className="sentry-heading">
                              <h3>{route.name}</h3>
                              <span
                                className={
                                  "sentry-health " + (route.enabled ? "sentry-health-live" : "")
                                }
                              >
                                {route.enabled ? "Watching" : "Paused"}
                              </span>
                            </div>
                            <p>
                              {route.organization} · {route.environment} ·{" "}
                              {route.delivery === "pr" ? "Draft PR" : "Local commit"}
                            </p>
                            <div className="sentry-route-controls">
                              <details className="sentry-route-details">
                                <summary>Repository details</summary>
                                <p className="sentry-path">{route.repositoryPath}</p>
                                <p>
                                  Base <code>{route.baseRef}</code>
                                </p>
                                <p>
                                  Last sync{" "}
                                  {dateLabel(
                                    status.syncs.find((value) => value.routeId === route.id)?.state
                                      .completedAt,
                                  )}
                                </p>
                                <p>
                                  {route.checks.length} required{" "}
                                  {route.checks.length === 1 ? "check" : "checks"}
                                </p>
                                <p>
                                  Query <code>{route.query}</code>
                                </p>
                                {route.service && (
                                  <p>
                                    Service <bdi>{route.service}</bdi>
                                  </p>
                                )}
                                {route.channel && (
                                  <p>
                                    Channel <bdi>{route.channel}</bdi>
                                  </p>
                                )}
                                {route.releases.length > 0 && (
                                  <p>
                                    Releases <bdi>{route.releases.join(", ")}</bdi>
                                  </p>
                                )}
                              </details>
                              <div className="sentry-actions">
                                <button
                                  disabled={pending(operationKey.route(route.id))}
                                  aria-busy={pending(operationKey.route(route.id))}
                                  aria-label={(route.enabled ? "Pause " : "Watch ") + route.name}
                                  onClick={() => client.toggleRoute(route.id, !route.enabled)}
                                >
                                  {pending(operationKey.route(route.id))
                                    ? "Saving…"
                                    : route.enabled
                                      ? "Pause watching"
                                      : "Watch issues"}
                                </button>
                                <button
                                  disabled={route.enabled || pending(operationKey.route(route.id))}
                                  onClick={() => openEditor(route)}
                                >
                                  Edit
                                </button>
                              </div>
                            </div>
                          </article>
                        ))}
                    </div>
                    <PolicyControl
                      key={policy.projectId}
                      policy={policy}
                      name={projectName(policy.projectId)}
                      busy={pending(operationKey.policy(policy.projectId))}
                      onSave={client.savePolicy}
                    />
                  </section>
                ))}
            </>
          )}
          {(tab === "Investigations" || tab === "Projects") &&
            status?.batches
              ?.filter((batch) => !selectedProject || batch.projectId === selectedProject)
              .map((batch) => (
                <article className="sentry-batch-report" key={batch.id}>
                  <div className="sentry-heading">
                    <h3>
                      {projectName(batch.projectId)} · {batch.issueCount} issues
                    </h3>
                    <span className="sentry-state">{batch.state}</span>
                  </div>
                  {batch.summary && <p>{batch.summary}</p>}
                  {batch.reason && <p role="alert">{batch.reason}</p>}
                  {batch.threadId && (
                    <button onClick={() => onOpenThread(batch.threadId!)}>
                      Open project solver ↗
                    </button>
                  )}
                </article>
              ))}
          {tab === "Inbox" && status && (
            <section aria-label="Open issues" className="sentry-inbox">
              {pageError && (
                <p role="alert" className="sentry-error">
                  Could not load issues for this view.
                </p>
              )}
              {!pagePending && !pageError && !incidents.length && offset === 0 && (
                <div className="sentry-empty">
                  <span className="sentry-empty-mark" aria-hidden="true">
                    ◉
                  </span>
                  <h2>
                    {filtered
                      ? "No matching issues"
                      : freshness === "unconfigured"
                        ? "Your inbox starts here"
                        : freshness === "live"
                          ? "No open issues"
                          : "Waiting for a complete sync"}
                  </h2>
                  <p>
                    {filtered
                      ? "Try another search or clear your filters to see more issues."
                      : freshness === "unconfigured"
                        ? "Connect a Sentry project to the repository where its fixes belong."
                        : "This inbox shows error and fatal issues from your watched repositories."}
                  </p>
                  {filtered && <button onClick={clearFilters}>Clear filters</button>}
                  {!filtered && !routes.some((value) => value.enabled) && (
                    <button onClick={() => setTab("Projects")}>Choose projects</button>
                  )}
                </div>
              )}
              <div className="sentry-issue-list">
                {incidents.map((incident) => {
                  const mappedRoutes = scopedRoutes.filter(
                    (value) =>
                      incident.matchedRouteIds.includes(value.id) &&
                      (!selected || value.id === selected),
                  );

                  const existing = status.runs.find(
                    (run) =>
                      (run.incident.key === incident.key ||
                        run.relatedIncidents?.some((issue) => issue.key === incident.key)) &&
                      isActiveRun(run.state),
                  );

                  return (
                    <IssueCard
                      key={incident.key}
                      incident={incident}
                      mappedRoutes={mappedRoutes}
                      existing={existing}
                      connected={status.connected}
                      models={models}
                      pending={pending}
                      onOpenThread={onOpenThread}
                      onInvestigate={client.investigate}
                    />
                  );
                })}
              </div>
              {(offset > 0 || hasNextPage) && (
                <div className="sentry-inline" aria-label="Issue pages">
                  <button disabled={offset === 0} onClick={() => setOffset(offset - inboxPageSize)}>
                    Previous page
                  </button>
                  {incidents.length > 0 && (
                    <span className="sentry-muted">
                      {offset + 1}–{offset + incidents.length} of {total}
                    </span>
                  )}
                  <button disabled={!hasNextPage} onClick={() => setOffset(offset + inboxPageSize)}>
                    Next page
                  </button>
                </div>
              )}
              {routes.length > 0 && (
                <details className="sentry-manual">
                  <summary>Start from a Sentry issue link</summary>
                  <form
                    className="sentry-inline"
                    onSubmit={(event) => {
                      event.preventDefault();

                      if (selectedRoute && issueUrl) client.investigate(selectedRoute.id, issueUrl);
                    }}
                  >
                    <label>
                      Route
                      <select
                        value={selectedRoute?.id ?? ""}
                        onChange={(event) => setRouteId(event.target.value)}
                      >
                        {manualRoutes.map((route) => (
                          <option key={route.id} value={route.id}>
                            {route.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="sentry-grow">
                      Sentry issue URL
                      <input
                        type="url"
                        required
                        value={issueUrl}
                        onChange={(event) => setIssueUrl(event.target.value)}
                        placeholder="https://your-org.sentry.io/issues/123/"
                      />
                    </label>
                    <button disabled={pending(operationKey.issue(issueUrl)) || !status.connected}>
                      {pending(operationKey.issue(issueUrl)) ? "Starting…" : "Start solver"}
                    </button>
                  </form>
                </details>
              )}
            </section>
          )}
          {tab === "Investigations" && status && (
            <Investigations
              runs={runs}
              selectedProject={selectedProject}
              selected={selected}
              onShowInbox={() => setTab("Inbox")}
              pending={pending}
              onOpenThread={onOpenThread}
              onStop={client.stop}
              onRetry={client.retry}
            />
          )}
        </div>
      </div>
    </main>
  );
}
