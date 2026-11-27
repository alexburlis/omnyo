import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  routeSchema,
  type Route,
  type SentryProject,
  type ProjectRepository,
} from "../../contract";
import { ProjectChoicesError } from "./project-choices-error";

const repositoryKey = (repository: ProjectRepository) =>
  JSON.stringify([repository.hostId, repository.path]);

export function ProjectSetup({
  organization,
  projects,
  onCatalog,
  onRepositories,
  onSave,
  onClose,
  onInteractOutside,
  targetsError,
  onRetryTargets,
}: {
  organization: string;
  projects: Array<{ id: string; name: string }>;
  onCatalog: (organization: string) => Promise<SentryProject[]>;
  onRepositories: (projectId: string) => Promise<ProjectRepository[]>;
  onSave: (route: Route) => Promise<boolean>;
  onClose: () => void;
  onInteractOutside: () => void;
  targetsError: string | null;
  onRetryTargets: () => void;
}) {
  const [org, setOrg] = useState(organization);
  const [catalog, setCatalog] = useState<SentryProject[]>([]);
  const [sentryId, setSentryId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [repositories, setRepositories] = useState<ProjectRepository[]>([]);
  const [selectedRepository, setSelectedRepository] = useState("");
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [loadingRepositories, setLoadingRepositories] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkCommand, setCheckCommand] = useState("");
  const [checkArgs, setCheckArgs] = useState("[]");
  const [baseRef, setBaseRef] = useState("");
  const catalogRequest = useRef(0);
  const repositoryRequest = useRef(0);
  const organizationInput = useRef<HTMLInputElement | null>(null);

  const repository = repositories.find(
    (repository) => repositoryKey(repository) === selectedRepository,
  );

  async function findProjects(value: string) {
    if (!value) return;
    const request = ++catalogRequest.current;
    setLoadingCatalog(true);
    setError(null);

    try {
      const found = await onCatalog(value);

      if (request !== catalogRequest.current) return;
      setCatalog(found);
      setSentryId("");

      if (!found.length) setError("No Sentry projects found in this organization.");
    } catch {
      if (request === catalogRequest.current)
        setError("Sentry projects could not load. Check the organization and connection.");
    } finally {
      if (request === catalogRequest.current) setLoadingCatalog(false);
    }
  }

  useEffect(() => {
    void findProjects(organization);

    return () => {
      catalogRequest.current++;
      repositoryRequest.current++;
    };
  }, []);

  async function chooseProject(value: string) {
    setProjectId(value);
    setSelectedRepository("");
    setRepositories([]);
    setLoadingRepositories(true);
    setError(null);
    const request = ++repositoryRequest.current;

    try {
      const found = await onRepositories(value);

      if (request !== repositoryRequest.current) return;
      setRepositories(found);

      if (!found.length)
        setError("No Git repositories found in this Omnyo project's local sources.");
    } catch {
      if (request === repositoryRequest.current)
        setError("Repositories could not load. Check this project's machine connection.");
    } finally {
      if (request === repositoryRequest.current) setLoadingRepositories(false);
    }
  }

  function chooseRepository(key: string) {
    setSelectedRepository(key);
    const selected = repositories.find((repository) => repositoryKey(repository) === key);
    setBaseRef(selected?.baseRef ?? "");
    setCheckCommand(selected?.checks[0]?.command ?? "");
    setCheckArgs(JSON.stringify(selected?.checks[0]?.args ?? []));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (!repository || !sentryId || !projectId) return;
    const data = new FormData(event.currentTarget);

    try {
      const project = catalog.find((project) => project.id === sentryId);

      if (!project) throw new Error("Choose a Sentry project");

      const value = routeSchema.parse({
        id: "route_" + crypto.randomUUID().replaceAll("-", ""),
        name: project.name,
        organization: org,
        sentryProjectId: sentryId,
        environment: data.get("environment"),
        projectId,
        hostId: repository.hostId,
        repositoryPath: repository.path,
        baseRef,
        githubRepository: repository.githubRepository,
        delivery: "local",
        enabled: false,
        checks: [
          {
            name: "Repository verification",
            command: checkCommand,
            args: JSON.parse(checkArgs),
            timeoutMs: 600000,
          },
        ],
        instructionPaths: repository.instructionPaths,
      });

      setSaving(true);

      if (await onSave(value)) onClose();
      else setError("Project could not save. Your choices are retained.");
    } catch {
      setError("Check the verification command, arguments and selected scope.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog.Root
      open
      modal={false}
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <Dialog.Content
        className="sentry-dialog sentry-form"
        onInteractOutside={onInteractOutside}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          organizationInput.current?.focus();
        }}
      >
        <div className="sentry-heading">
          <div>
            <span className="sentry-eyebrow">New connection</span>
            <Dialog.Title>Add project</Dialog.Title>
          </div>
          <Dialog.Close aria-label="Close project setup" disabled={saving}>
            ×
          </Dialog.Close>
        </div>
        <Dialog.Description>Connect a Sentry project to its local repository.</Dialog.Description>
        <ProjectChoicesError error={targetsError} onRetry={onRetryTargets} />
        <form
          onSubmit={(event) => {
            void submit(event);
          }}
        >
          <fieldset disabled={saving}>
            <div className="sentry-setup-step">
              <span>1</span>Choose the source
            </div>
            <div className="sentry-discovery-row">
              <label>
                Sentry organization
                <input
                  ref={organizationInput}
                  required
                  value={org}
                  onChange={(event) => {
                    setOrg(event.target.value);
                    catalogRequest.current++;
                    setLoadingCatalog(false);
                    setCatalog([]);
                    setSentryId("");
                  }}
                />
              </label>
              <button
                type="button"
                onClick={() => {
                  void findProjects(org);
                }}
                disabled={!org || loadingCatalog}
              >
                {loadingCatalog ? "Finding…" : "Find projects"}
              </button>
            </div>
            <label>
              Sentry project
              <select
                required
                aria-label="Sentry project"
                value={sentryId}
                disabled={loadingCatalog}
                onChange={(event) => setSentryId(event.target.value)}
              >
                <option value="">
                  {loadingCatalog ? "Loading projects…" : "Choose a Sentry project"}
                </option>
                {catalog.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name} · {project.slug}
                  </option>
                ))}
              </select>
            </label>
            <div className="sentry-setup-step">
              <span>2</span>Choose where fixes belong
            </div>
            <div className="sentry-grid">
              <label>
                Omnyo project
                <select
                  required
                  aria-label="Omnyo project"
                  value={projectId}
                  onChange={(event) => {
                    void chooseProject(event.target.value);
                  }}
                >
                  <option value="">Choose an Omnyo project</option>
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Environment
                <input name="environment" required defaultValue="production" />
              </label>
            </div>
            <label>
              Repository
              <select
                required
                aria-label="Repository"
                value={selectedRepository}
                disabled={loadingRepositories || !projectId}
                onChange={(event) => chooseRepository(event.target.value)}
              >
                <option value="">
                  {loadingRepositories ? "Finding repositories…" : "Choose a repository"}
                </option>
                {repositories.map((repository) => (
                  <option key={repositoryKey(repository)} value={repositoryKey(repository)}>
                    {repository.name} · {repository.baseRef}
                  </option>
                ))}
              </select>
            </label>
            {repository && <p className="sentry-path">{repository.path}</p>}
            <details open={Boolean(repository && !repository.checks.length)}>
              <summary>Verification and base branch</summary>
              <label>
                Base branch
                <input
                  required
                  value={baseRef}
                  onChange={(event) => setBaseRef(event.target.value)}
                />
              </label>
              <label>
                Verification command
                <input
                  required
                  placeholder="npm"
                  value={checkCommand}
                  onChange={(event) => setCheckCommand(event.target.value)}
                />
              </label>
              <label>
                Arguments (JSON)
                <input
                  required
                  value={checkArgs}
                  onChange={(event) => setCheckArgs(event.target.value)}
                />
              </label>
            </details>
            <p className="sentry-setup-note">
              Watching starts after saving. Solvers stay manual and fixes stay local.
            </p>
            <div className="sentry-setup-feedback" role="status">
              {error && <span role="alert">{error}</span>}
            </div>
            <div className="sentry-actions sentry-dialog-actions">
              <button type="button" onClick={onClose}>
                Cancel
              </button>
              <button
                className="sentry-primary"
                disabled={!repository || !sentryId || !checkCommand || saving}
              >
                {saving ? "Saving…" : "Save and watch"}
              </button>
            </div>
          </fieldset>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  );
}
