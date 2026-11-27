import { useDraft, useMachines } from "../data/hooks.js";
import { ErrorAlert, Skeleton } from "../primitives.js";
import { MachineTabs, Page } from "../shell.js";

export function MachineSettings({ machineId }: { machineId: string }) {
  const draft = useDraft(machineId);
  const machines = useMachines(null);
  const machine = machines.data?.find((item) => item.machineId === machineId);
  const document = draft.data?.document;

  const externalWrite = (document?.states ?? []).filter(
    (state) =>
      (state.kind === "agent" || state.kind === "command") && state.effect === "external-write",
  );

  return (
    <Page
      crumbs={[
        { label: "State machines", route: { screen: "list" } },
        { label: machine?.name ?? "Machine", route: { screen: "machine", machineId } },
        { label: "Settings", route: null },
      ]}
      title={machine?.name ?? "Settings"}
      tabs={<MachineTabs machineId={machineId} active="settings" />}
    >
      {draft.error === null ? null : (
        <ErrorAlert error={draft.error} onRetry={draft.refetch} subject="machine" />
      )}
      {document === undefined && draft.error === null ? <Skeleton rows={4} height={32} /> : null}
      {document === undefined ? null : (
        <>
          <section className="stm-card" aria-labelledby="stm-settings-limits">
            <h2 id="stm-settings-limits" className="stm-h2">
              Limits
            </h2>
            <dl className="stm-kv">
              <div className="stm-kv-row">
                <dt className="stm-text-muted">Instant steps per wake</dt>
                <dd>{document.limits.microstepsPerWake}</dd>
              </div>
              <div className="stm-kv-row">
                <dt className="stm-text-muted">Step starts per 5 minutes</dt>
                <dd>{document.limits.actionStartsPerFiveMinutes}</dd>
              </div>
              <div className="stm-kv-row">
                <dt className="stm-text-muted">Repair attempts per source</dt>
                <dd>{document.limits.repairAttemptsPerSubject}</dd>
              </div>
            </dl>
            <p className="stm-field-hint">Read only. The runtime owns these limits.</p>
          </section>
          <section className="stm-card" aria-labelledby="stm-settings-context">
            <h2 id="stm-settings-context" className="stm-h2">
              Context values
            </h2>
            <ul className="stm-list">
              {Object.entries(document.contextSchema.properties).map(([key, schema]) => (
                <li key={key} className="stm-text-sm">
                  <code className="stm-mono">{key}</code> · {schema.type}
                  {schema.readOnly === true ? " · read only" : " · writable"}
                </li>
              ))}
            </ul>
            <p className="stm-field-hint">Edit context values in the draft's overview.</p>
          </section>
          <section className="stm-card" aria-labelledby="stm-settings-authority">
            <h2 id="stm-settings-authority" className="stm-h2">
              Authority
            </h2>
            {externalWrite.length === 0 ? (
              <p className="stm-text-sm stm-text-muted">No step changes external services.</p>
            ) : null}
            <ul className="stm-list">
              {externalWrite.map((state) => (
                <li key={state.id} className="stm-text-sm">
                  {state.title} ·{" "}
                  {state.kind === "agent" || state.kind === "command" ? state.effectTarget : ""} ·
                  Needs verifiable approval (not available yet), unless an exact existing standing
                  authority covers it.
                </li>
              ))}
            </ul>
            <p className="stm-field-hint">
              Omnyo records no provider permission here and changes no provider.
            </p>
          </section>
        </>
      )}
    </Page>
  );
}
