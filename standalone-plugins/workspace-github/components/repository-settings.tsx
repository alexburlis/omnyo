import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRpc, type PluginRpcResult } from "@omnyo/plugin-sdk/app";
import type { githubRpcContract } from "../server.js";
import { SyncNotice } from "./sync-notice.js";
import { Button } from "./ui/button.js";
import { Input } from "./ui/input.js";

type Catalog = PluginRpcResult<(typeof githubRpcContract)["repositorySettings"]>;

type Filter = "all" | "included" | "excluded";

export function RepositorySettings() {
  const rpc = useRpc<typeof githubRpcContract>();
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);

  const load = useCallback(
    async (refresh = false) => {
      const current = ++request.current;
      setLoading(true);

      try {
        const next = await rpc.call("repositorySettings", { refresh });

        if (current === request.current) {
          setCatalog(next);
          setError(null);
        }
      } catch (cause) {
        if (current === request.current) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      } finally {
        if (current === request.current) setLoading(false);
      }
    },
    [rpc],
  );

  useEffect(() => {
    void load();

    return () => {
      request.current++;
    };
  }, [load]);
  useRealtime("data-changed", () => {
    void load();
  });

  async function toggle(repo: Catalog["repos"][number]) {
    setPending(repo.repo);
    setError(null);

    try {
      await rpc.call("setRepoExcluded", { repo: repo.repo, excluded: !repo.excluded });
      setCatalog((previous) =>
        previous === null
          ? null
          : {
              ...previous,
              repos: previous.repos
                .map((entry) =>
                  entry.repo === repo.repo ? { ...entry, excluded: !repo.excluded } : entry,
                )
                .filter((entry) => entry.available || entry.excluded),
            },
      );
      void load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(null);
    }
  }

  const repos = catalog?.repos ?? [];
  const included = repos.filter((repo) => !repo.excluded).length;
  const projects = new Map(catalog?.projects.map((project) => [project.id, project.name]) ?? []);
  const needle = query.trim().toLowerCase();

  const visible = repos.filter((repo) => {
    if (filter === "included" && repo.excluded) return false;

    if (filter === "excluded" && !repo.excluded) return false;
    const project = repo.projectId === null ? "" : (projects.get(repo.projectId) ?? "");

    return `${repo.repo} ${project}`.toLowerCase().includes(needle);
  });

  const filters: { value: Filter; label: string; count: number }[] = [
    { value: "all", label: "All", count: repos.length },
    { value: "included", label: "Included", count: included },
    { value: "excluded", label: "Excluded", count: repos.length - included },
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1" aria-label="Repository inclusion filters">
          {filters.map((choice) => (
            <Button
              key={choice.value}
              type="button"
              size="sm"
              variant={filter === choice.value ? "secondary" : "ghost"}
              className="rounded-full"
              aria-pressed={filter === choice.value}
              onClick={() => setFilter(choice.value)}
            >
              {choice.label} ({choice.count})
            </Button>
          ))}
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="ml-auto"
          aria-label="Refresh repositories"
          disabled={loading || pending !== null}
          onClick={() => {
            void load(true);
          }}
        >
          {loading ? "Refreshing…" : "Refresh"}
        </Button>
      </div>
      <Input
        aria-label="Search repositories"
        placeholder="Search repositories or projects…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {error !== null && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {catalog === null ? null : (
        <SyncNotice
          scope="discovery"
          warnings={catalog.warnings}
          notices={[]}
          error={null}
          loaded
        />
      )}
      {catalog === null ? (
        <p className="py-4 text-sm text-muted-foreground">
          {loading ? "Loading repositories…" : "Could not load repositories."}
        </p>
      ) : (
        <div className="max-h-[28rem] space-y-1 overflow-y-auto pr-1" aria-label="Repositories">
          {visible.map((repo) => (
            <Button
              key={repo.repo}
              type="button"
              variant="ghost"
              role="switch"
              aria-label={`Include ${repo.repo}`}
              aria-checked={!repo.excluded}
              disabled={pending !== null}
              className="h-auto min-h-14 w-full justify-between gap-3 rounded-md border border-border px-3 py-2 text-left whitespace-normal"
              onClick={() => {
                void toggle(repo);
              }}
            >
              <span className="min-w-0">
                <span className="block break-all text-sm font-medium">{repo.repo}</span>
                <span className="block text-xs font-normal text-muted-foreground">
                  {!repo.available
                    ? "No longer tracked"
                    : repo.projectId === null
                      ? "Extra repository"
                      : projects.get(repo.projectId)}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-2">
                <span className="text-xs font-normal text-muted-foreground">
                  {pending === repo.repo ? "Saving…" : repo.excluded ? "Excluded" : "Included"}
                </span>
                <span
                  aria-hidden="true"
                  className={`flex h-5 w-9 items-center rounded-full p-0.5 transition-colors duration-250 ${repo.excluded ? "bg-muted" : "bg-primary"}`}
                >
                  <span
                    className={`h-4 w-4 rounded-full bg-background shadow-sm transition-transform duration-250 ease-in-out ${repo.excluded ? "translate-x-0" : "translate-x-4"}`}
                  />
                </span>
              </span>
            </Button>
          ))}
          {visible.length === 0 && (
            <p className="py-4 text-center text-sm text-muted-foreground">
              {repos.length === 0 ? "No repositories found." : "No repositories match."}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
