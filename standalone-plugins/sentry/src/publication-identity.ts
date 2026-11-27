export function runMarker(runId: string) {
  return "sentry-run:" + runId;
}

export function hasRunMarker(body: string, runId: string) {
  return body.split(/\r?\n/u).some((line) => line === runMarker(runId));
}
