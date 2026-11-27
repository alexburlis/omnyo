import { useState, type FormEvent } from "react";
import { routeSchema, type Route } from "../../contract";
import type { InboxTargets } from "./projection";
import { ProjectChoicesError } from "./project-choices-error";

export function RouteEditor({
  route,
  targets,
  projectMissing,
  onSave,
  onClose,
  targetsError,
  onRetryTargets,
}: {
  route: Route;
  targets: InboxTargets;
  projectMissing: boolean;
  onSave: (value: Route) => Promise<boolean>;
  onClose: () => void;
  targetsError: string | null;
  onRetryTargets: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);

    try {
      const value = routeSchema.parse({
        ...route,
        id: data.get("id"),
        name: data.get("name"),
        organization: data.get("organization"),
        sentryProjectId: data.get("sentryProjectId"),
        environment: data.get("environment"),
        projectId: data.get("projectId"),
        hostId: data.get("hostId"),
        repositoryPath: data.get("repositoryPath"),
        baseRef: data.get("baseRef"),
        delivery: data.get("delivery"),
        githubRepository: data.get("githubRepository") || null,
        checks: JSON.parse(String(data.get("checks"))),
        releases: String(data.get("releases"))
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
        service: data.get("service") || null,
        channel: data.get("channel") || null,
        query: data.get("query") || "is:unresolved",
        instructionPaths: String(data.get("instructionPaths"))
          .split("\n")
          .map((value) => value.trim())
          .filter(Boolean),
      });

      setSaving(true);

      if (await onSave(value)) onClose();
    } catch {
      setError("Check the route fields and verification command JSON.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      className="sentry-form"
      aria-busy={saving}
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      <fieldset disabled={saving}>
        <div className="sentry-heading">
          <h2>Edit route</h2>
          <button type="button" aria-label="Close repository mapping" onClick={onClose}>
            ×
          </button>
        </div>
        {error && <p role="alert">{error}</p>}
        <ProjectChoicesError error={targetsError} onRetry={onRetryTargets} />
        <div className="sentry-grid">
          <label>
            Route ID
            <input name="id" required defaultValue={route.id} readOnly />
          </label>
          <label>
            Name
            <input name="name" required defaultValue={route.name} />
          </label>
          <label>
            Sentry organization
            <input name="organization" required defaultValue={route.organization} />
          </label>
          <label>
            Sentry project ID
            <input
              name="sentryProjectId"
              required
              inputMode="numeric"
              defaultValue={route.sentryProjectId}
            />
          </label>
          <label>
            Environment
            <input name="environment" required defaultValue={route.environment} />
          </label>
          <label>
            Omnyo project
            <select name="projectId" required defaultValue={projectMissing ? "" : route.projectId}>
              <option value="" disabled>
                Choose a project
              </option>
              {targets.projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Execution machine
            <select name="hostId" required defaultValue={route.hostId}>
              <option value="" disabled>
                Choose a machine
              </option>
              {targets.hosts.map((host) => (
                <option key={host.id} value={host.id}>
                  {host.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Repository path
            <input
              name="repositoryPath"
              required
              defaultValue={route.repositoryPath}
              placeholder="/path/to/repository"
            />
          </label>
          <label>
            Base ref
            <input name="baseRef" required defaultValue={route.baseRef} />
          </label>
          <label>
            Delivery
            <select name="delivery" defaultValue={route.delivery}>
              <option value="local">Local commit</option>
              <option value="pr">Draft pull request</option>
            </select>
          </label>
          <label>
            GitHub repository
            <input
              name="githubRepository"
              defaultValue={route.githubRepository ?? ""}
              placeholder="owner/repository"
            />
          </label>
          <label>
            Exposed releases
            <input
              name="releases"
              defaultValue={route.releases.join(", ")}
              placeholder="Comma-separated exact identities"
            />
          </label>
          <label>
            Service
            <input name="service" defaultValue={route.service ?? ""} />
          </label>
          <label>
            Channel
            <input name="channel" defaultValue={route.channel ?? ""} />
          </label>
        </div>
        <label>
          Sentry query
          <input name="query" defaultValue={route.query} />
        </label>
        <label>
          Required checks
          <textarea
            name="checks"
            required
            rows={4}
            defaultValue={JSON.stringify(route.checks, null, 2)}
          />
        </label>
        <label>
          Canonical instruction files
          <textarea
            name="instructionPaths"
            rows={2}
            defaultValue={route.instructionPaths.join("\n")}
          />
        </label>
        <p>
          Saving keeps watching paused. Draft PR delivery permits fix-branch pushes and draft PRs
          for this repository when you start a solver or opt into auto solve.
        </p>
        <div className="sentry-actions">
          <button type="submit">{saving ? "Saving…" : "Save route"}</button>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </fieldset>
    </form>
  );
}
