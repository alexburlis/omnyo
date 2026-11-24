const GATE_REAUTH_HEADER = "x-omnyo-gate-reauth";

const GATE_REAUTH_RELOAD_KEY = "omnyo:gate-reauth-reloaded-at";

const GATE_REAUTH_RELOAD_WINDOW_MS = 60_000;

function requiresGateReauth(response: Response): boolean {
  return (
    response.status === 401 && response.headers.get(GATE_REAUTH_HEADER) === "1"
  );
}

export function reloadForGateReauth(response: Response): boolean {
  if (typeof window === "undefined" || !requiresGateReauth(response)) {
    return false;
  }

  const now = Date.now();

  try {
    const reloadedAt = Number(
      window.sessionStorage.getItem(GATE_REAUTH_RELOAD_KEY),
    );

    if (now >= reloadedAt && now - reloadedAt < GATE_REAUTH_RELOAD_WINDOW_MS) {
      return false;
    }

    window.sessionStorage.setItem(GATE_REAUTH_RELOAD_KEY, String(now));
    (window.top ?? window).location.reload();
  } catch {
    return false;
  }

  return true;
}
