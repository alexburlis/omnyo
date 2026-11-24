import { useCallback, useEffect, useRef, useState } from "react";
import {
  definePluginApp,
  useRealtime,
  useRpc,
  type StandardSchemaV1InferOutput,
} from "@omnyo/plugin-sdk/app";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { MAX_LIMIT_VALUE, parseLimitValue } from "./limits.js";
import {
  formatNeed,
  hostSetting,
  NEED_TOKENS,
  parseNeedToken,
  type Need,
} from "./overflow.js";
import type { concurrencyLimitRpcContract } from "./server.js";

type ConfigurationView = StandardSchemaV1InferOutput<
  (typeof concurrencyLimitRpcContract)["getConfiguration"]["output"]
>;

type ConfigurationInput = Pick<
  ConfigurationView,
  "globalLimit" | "hostOverrides" | "overflow"
>;

type HostView = ConfigurationView["hosts"][number];

type SaveState = "idle" | "saving" | "saved" | "error";

const CONFIGURATION_CHANGED_CHANNEL = "configuration-changed";

const GLOBAL_FIELD = "global";

const NEEDS_FIELD_PREFIX = "needs:";

const OS_LABELS = { macos: "macOS", windows: "Windows", linux: "Linux" };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function needsText(needs: readonly Need[] | null): string {
  return needs === null ? "" : needs.map(formatNeed).join(", ");
}

function draftsFor(view: ConfigurationView): Record<string, string> {
  const drafts: Record<string, string> = {
    [GLOBAL_FIELD]: view.globalLimit === null ? "" : String(view.globalLimit),
  };

  for (const host of view.hosts) {
    drafts[host.id] = host.override === null ? "" : String(host.override);
  }

  for (const project of view.projects) {
    drafts[`${NEEDS_FIELD_PREFIX}${project.id}`] = needsText(project.needs);
  }

  return drafts;
}

function parseDraft(
  raw: string,
): { ok: true; value: number | null } | { ok: false } {
  const trimmed = raw.trim();

  if (trimmed === "") return { ok: true, value: null };
  const value = parseLimitValue(trimmed);

  return value === null ? { ok: false } : { ok: true, value };
}

function parseNeedsDraft(
  raw: string,
): { ok: true; value: Need[] | null } | { ok: false } {
  const tokens = raw
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token !== "");

  if (tokens.length === 0) return { ok: true, value: null };
  const needs: Need[] = [];

  for (const token of tokens) {
    const need = parseNeedToken(token);

    if (need === null) return { ok: false };
    needs.push(need);
  }

  return { ok: true, value: needs };
}

function describeHost(host: HostView): string {
  const parts: string[] = [];

  if (host.availableParallelism !== null) {
    parts.push(`${host.availableParallelism} processors`);
  }

  if (host.facts !== null) {
    parts.push(`${OS_LABELS[host.facts.os]} ${host.facts.arch}`);

    if (host.facts.tools.xcode) parts.push("Xcode");

    if (host.facts.tools.nvidiaGpu !== null) {
      parts.push(host.facts.tools.nvidiaGpu);
    }
  }

  if (host.status === "disconnected") parts.push("Offline");

  return parts.length === 0 ? "Detecting processors…" : parts.join(" · ");
}

function ConcurrencyLimitSettings() {
  const rpc = useRpc<typeof concurrencyLimitRpcContract>();
  const [view, setView] = useState<ConfigurationView | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [invalidField, setInvalidField] = useState<string | null>(null);
  const activeRef = useRef(true);
  const savingRef = useRef(false);

  const applyView = useCallback((next: ConfigurationView) => {
    setView(next);
    setDrafts(draftsFor(next));
  }, []);

  const refetch = useCallback(() => {
    if (savingRef.current) return;
    void rpc.call("getConfiguration").then(
      (configuration) => {
        if (!activeRef.current || savingRef.current) return;
        applyView(configuration);
        setError(null);
        setSaveState("saved");
      },
      (loadError: unknown) => {
        if (!activeRef.current) return;
        setError(errorMessage(loadError));
        setSaveState("error");
      },
    );
  }, [applyView, rpc]);

  useEffect(() => {
    activeRef.current = true;
    refetch();

    return () => {
      activeRef.current = false;
    };
  }, [refetch]);
  useRealtime(CONFIGURATION_CHANGED_CHANNEL, refetch);

  async function save(next: ConfigurationInput): Promise<void> {
    savingRef.current = true;
    setSaveState("saving");
    setError(null);

    try {
      const saved = await rpc.call("setConfiguration", next);

      if (!activeRef.current) return;
      applyView(saved);
      setSaveState("saved");
    } catch (saveError) {
      if (!activeRef.current) return;
      setError(errorMessage(saveError));
      setSaveState("error");
    } finally {
      savingRef.current = false;
    }
  }

  function current(): ConfigurationInput | null {
    if (view === null) return null;

    return {
      globalLimit: view.globalLimit,
      hostOverrides: view.hostOverrides,
      overflow: view.overflow,
    };
  }

  function changeDraft(field: string, value: string): void {
    setDrafts((existing) => ({ ...existing, [field]: value }));

    if (invalidField === field) setInvalidField(null);
  }

  function commitGlobal(): void {
    const base = current();

    if (base === null) return;
    const parsed = parseDraft(drafts[GLOBAL_FIELD] ?? "");

    if (!parsed.ok) {
      setInvalidField(GLOBAL_FIELD);

      return;
    }

    if (parsed.value === base.globalLimit) return;
    void save({ ...base, globalLimit: parsed.value });
  }

  function commitHost(hostId: string): void {
    const base = current();

    if (base === null) return;
    const parsed = parseDraft(drafts[hostId] ?? "");

    if (!parsed.ok) {
      setInvalidField(hostId);

      return;
    }

    const existing = base.hostOverrides.find(
      (override) => override.hostId === hostId,
    );

    if (parsed.value === (existing?.limit ?? null)) return;

    const hostOverrides = base.hostOverrides.filter(
      (override) => override.hostId !== hostId,
    );

    if (parsed.value !== null)
      hostOverrides.push({ hostId, limit: parsed.value });
    void save({ ...base, hostOverrides });
  }

  function setOverflowEnabled(enabled: boolean): void {
    const base = current();

    if (base === null) return;
    void save({ ...base, overflow: { ...base.overflow, enabled } });
  }

  function setTakesOverflow(hostId: string, takesOverflow: boolean): void {
    const base = current();

    if (base === null) return;
    const setting = hostSetting(base.overflow, hostId);

    const hosts = base.overflow.hosts.filter((host) => host.hostId !== hostId);

    if (!takesOverflow || setting.tags.length > 0) {
      hosts.push({ ...setting, takesOverflow });
    }

    void save({ ...base, overflow: { ...base.overflow, hosts } });
  }

  function commitNeeds(projectId: string): void {
    const base = current();

    if (base === null) return;
    const field = `${NEEDS_FIELD_PREFIX}${projectId}`;
    const parsed = parseNeedsDraft(drafts[field] ?? "");

    if (!parsed.ok) {
      setInvalidField(field);

      return;
    }

    const existing =
      base.overflow.projectNeeds.find((entry) => entry.projectId === projectId)
        ?.needs ?? null;

    if (needsText(parsed.value) === needsText(existing)) return;

    const projectNeeds = base.overflow.projectNeeds.filter(
      (entry) => entry.projectId !== projectId,
    );

    if (parsed.value !== null) {
      projectNeeds.push({ projectId, needs: parsed.value });
    }

    void save({ ...base, overflow: { ...base.overflow, projectNeeds } });
  }

  if (view === null) {
    return (
      <p
        className={
          error === null
            ? "text-sm text-muted-foreground"
            : "text-sm text-destructive"
        }
        role={error === null ? "status" : "alert"}
      >
        {error ?? "Loading limits…"}
      </p>
    );
  }

  const disabled = saveState === "saving";
  const overflowOn = view.overflow.enabled;

  const validationMessage =
    invalidField?.startsWith(NEEDS_FIELD_PREFIX) === true
      ? `Use ${NEED_TOKENS}, separated by commas, or leave blank.`
      : `Use a whole number from 0 to ${MAX_LIMIT_VALUE}, or leave blank.`;

  return (
    <div className="w-full space-y-5">
      <div className="flex items-start justify-between gap-6 pr-2">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-foreground">Overall limit</h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Leave blank for no overall limit. Use 0 to pause new work.
          </p>
        </div>
        <Input
          aria-label="Overall thread limit"
          aria-invalid={invalidField === GLOBAL_FIELD}
          className="w-28 shrink-0"
          disabled={disabled}
          inputMode="numeric"
          max={MAX_LIMIT_VALUE}
          min={0}
          placeholder="Unlimited"
          step={1}
          type="number"
          value={drafts[GLOBAL_FIELD] ?? ""}
          onBlur={commitGlobal}
          onChange={(event) => changeDraft(GLOBAL_FIELD, event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
      </div>

      <div className="flex items-start justify-between gap-6 border-t border-border/60 pt-4 pr-2">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-foreground">
            Start waiting chats on a free machine
          </h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Only new chats move, to a machine that meets the project's needs.
          </p>
        </div>
        <Switch
          checked={overflowOn}
          size="default"
          aria-label="Start waiting chats on a free machine"
          disabled={disabled}
          onCheckedChange={setOverflowEnabled}
        />
      </div>

      <div className="border-t border-border/60 pt-4">
        <h3 className="text-sm font-medium text-foreground">Host limits</h3>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Auto allows one thread per available processor.
        </p>

        <div className="ml-2 mt-2 border-l border-border/60 pl-2">
          {view.hosts.length === 0 ? (
            <p className="px-2 py-2 text-sm text-muted-foreground">
              No hosts available.
            </p>
          ) : (
            <div className="space-y-1">
              {view.hosts.map((host) => (
                <div
                  key={host.id}
                  className="flex min-h-14 items-center gap-3 rounded-md px-2 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-foreground">
                      {host.name}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {describeHost(host)}
                    </div>
                  </div>
                  <Input
                    aria-label={`${host.name} thread limit`}
                    aria-invalid={invalidField === host.id}
                    className="w-28 shrink-0"
                    disabled={disabled}
                    inputMode="numeric"
                    max={MAX_LIMIT_VALUE}
                    min={0}
                    placeholder={`Auto (${host.automaticLimit})`}
                    step={1}
                    type="number"
                    value={drafts[host.id] ?? ""}
                    onBlur={() => commitHost(host.id)}
                    onChange={(event) =>
                      changeDraft(host.id, event.target.value)
                    }
                    onKeyDown={(event) => {
                      if (event.key === "Enter") event.currentTarget.blur();
                    }}
                  />
                  {overflowOn ? (
                    <Switch
                      checked={host.takesOverflow}
                      size="default"
                      aria-label={`${host.name} takes waiting chats from full machines`}
                      disabled={disabled}
                      onCheckedChange={(takesOverflow) =>
                        setTakesOverflow(host.id, takesOverflow)
                      }
                    />
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {overflowOn ? (
        <div className="border-t border-border/60 pt-4">
          <h3 className="text-sm font-medium text-foreground">Project needs</h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Blank keeps chats on machines with the same system.
          </p>

          <div className="ml-2 mt-2 space-y-1 border-l border-border/60 pl-2">
            {view.projects.map((project) => {
              const field = `${NEEDS_FIELD_PREFIX}${project.id}`;

              return (
                <div
                  key={project.id}
                  className="flex min-h-12 items-center gap-3 rounded-md px-2 py-1.5 hover:bg-accent/50"
                >
                  <div className="min-w-0 flex-1 truncate text-sm text-foreground">
                    {project.name}
                  </div>
                  <Input
                    aria-label={`${project.name} needs`}
                    aria-invalid={invalidField === field}
                    className="w-56 shrink-0"
                    disabled={disabled}
                    placeholder="Same system"
                    value={drafts[field] ?? ""}
                    onBlur={() => commitNeeds(project.id)}
                    onChange={(event) => changeDraft(field, event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") event.currentTarget.blur();
                    }}
                  />
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      <div className="flex min-h-5 justify-end" aria-live="polite">
        {invalidField !== null ? (
          <span className="text-xs text-destructive" role="alert">
            {validationMessage}
          </span>
        ) : error !== null ? (
          <span className="text-xs text-destructive" role="alert">
            {error}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground" role="status">
            {saveState === "saving" ? "Saving…" : "Saved"}
          </span>
        )}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "configuration",
    component: ConcurrencyLimitSettings,
  });
});
