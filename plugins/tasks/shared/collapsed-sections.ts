import { useCallback, useState } from "react";

export const COLLAPSED_SECTIONS_STORAGE_KEY = "tasks:collapsed-sections";

const COLLAPSED_SECTIONS_VERSION = 1 as const;

type ScopeMap = Record<string, readonly string[]>;

function readScopes(): ScopeMap {
  try {
    const raw = window.localStorage.getItem(COLLAPSED_SECTIONS_STORAGE_KEY);

    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);

    if (typeof parsed !== "object" || parsed === null) return {};

    if (Reflect.get(parsed, "version") !== COLLAPSED_SECTIONS_VERSION) {
      return {};
    }

    const scopes: unknown = Reflect.get(parsed, "scopes");

    if (typeof scopes !== "object" || scopes === null) return {};
    const result: Record<string, string[]> = {};

    for (const [scope, ids] of Object.entries(scopes)) {
      if (!Array.isArray(ids)) continue;
      result[scope] = ids.filter((id): id is string => typeof id === "string");
    }

    return result;
  } catch {
    return {};
  }
}

export function loadCollapsedSections(scope: string): ReadonlySet<string> {
  return new Set(readScopes()[scope] ?? []);
}

export function storeCollapsedSections(
  scope: string,
  collapsed: ReadonlySet<string>,
): void {
  try {
    const scopes = { ...readScopes() };

    if (collapsed.size === 0) delete scopes[scope];
    else scopes[scope] = [...collapsed];

    window.localStorage.setItem(
      COLLAPSED_SECTIONS_STORAGE_KEY,
      JSON.stringify({ version: COLLAPSED_SECTIONS_VERSION, scopes }),
    );
  } catch {}
}

export interface CollapsedSections {
  isOpen: (sectionId: string) => boolean;
  setOpen: (sectionId: string, open: boolean) => void;
}

export function useCollapsedSections(scope: string): CollapsedSections {
  const [state, setState] = useState(() => ({
    scope,
    collapsed: loadCollapsedSections(scope),
  }));

  const current =
    state.scope === scope
      ? state
      : { scope, collapsed: loadCollapsedSections(scope) };

  if (current !== state) setState(current);

  const setOpen = useCallback(
    (sectionId: string, open: boolean) => {
      setState((previous) => {
        const base =
          previous.scope === scope
            ? previous.collapsed
            : loadCollapsedSections(scope);

        const next = new Set(base);

        if (open) next.delete(sectionId);
        else next.add(sectionId);
        storeCollapsedSections(scope, next);

        return { scope, collapsed: next };
      });
    },
    [scope],
  );

  return {
    isOpen: (sectionId) => !current.collapsed.has(sectionId),
    setOpen,
  };
}
