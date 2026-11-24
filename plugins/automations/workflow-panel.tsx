import { useEffect, useId, useState, type FormEvent } from "react";
import {
  experimental_useAppNavigate,
  UrlLink,
  useRpc,
} from "@omnyo/plugin-sdk/app";
import type { z } from "zod";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { EmptyStateBlock } from "@/components/ui/empty-state";
import { FileDropZone, type ChosenFile } from "@/components/ui/file-drop-zone";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import {
  ResourceListState,
  ResourceToolbar,
} from "@/components/ui/resource-list";
import { DISCLOSURE_CHEVRON_TRANSITION } from "@/components/ui/motion";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  StepTransition,
  type StepDirection,
} from "@/components/ui/step-transition";
import { SuccessCheck } from "@/components/ui/success-check";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { AutomationResponse } from "./src/rpc-types";
import type { automationRpcContract } from "./src/rpc";
import type { workflowRpcContract } from "./src/workflow-contract";
import { errorMessage, type Copy } from "./workflow-panel-shared";
import { WorkflowRuns } from "./workflow-runs";
import {
  discardSetupDraft,
  hasSetupDraft,
  restoreSetupDraft,
  saveSetupDraft,
  type ResearchDraft,
} from "./workflow-draft";
import {
  ResearchPicker,
  ResearchEvidence,
  type ResearchSelection,
} from "./workflow-research";
import {
  BriefForm,
  BriefSummary,
  copyStatus,
  DeviceModelFields,
  Disclosure,
  ErrorNote,
  initialInputs,
  isWeeklyFeed,
  NativeSelect,
  PackageReview,
  Panel,
  SetupProgress,
  StatusPill,
  triggerSummary,
  WeekPreview,
  type InputValues,
  type Review,
  type SetupOptions,
} from "./workflow-setup";

type Source = z.input<
  (typeof workflowRpcContract)["workflow_inspect"]["input"]
>;

type RevisionComparison = z.output<
  (typeof workflowRpcContract)["workflow_compare"]["output"]
>;

type SourceChoice = "notes" | "openseo";

export function WorkflowSetupReturn() {
  const navigate = experimental_useAppNavigate();
  const params = new URLSearchParams(window.location.search);
  const projectId = params.get("workflowProject");
  const importId = params.get("workflowCopy");

  if (!projectId || !importId || !hasSetupDraft({ projectId, importId }))
    return null;

  return (
    <Button
      variant="outline"
      onClick={() =>
        navigate.toPluginPanel("automations", {
          subPath: `copies/${projectId}/${importId}`,
          replace: true,
        })
      }
    >
      Return to workflow setup
    </Button>
  );
}

function initialResearchDraft(copy: Copy | undefined): ResearchDraft {
  const source = copy?.source ?? copy?.draftSource;

  return source?.kind === "openseo"
    ? { site: source.site, keepSaved: true }
    : { site: "", keepSaved: false };
}

function savedSourceChoice(copy: Copy | undefined): SourceChoice {
  return (copy?.source ?? copy?.draftSource)?.kind ?? "notes";
}

type NativeReference =
  | { kind: "share"; shareId: string }
  | { kind: "file"; filename: string; text: string };

const chevron = cn(
  "size-3.5 shrink-0 text-muted-foreground group-open:rotate-90",
  DISCLOSURE_CHEVRON_TRANSITION,
);

const summaryRow =
  "flex cursor-pointer list-none items-center gap-1.5 [&::-webkit-details-marker]:hidden";

function ProjectSelect({
  label,
  value,
  choices,
  onChange,
}: {
  label: string;
  value: string;
  choices: SetupOptions | undefined;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium">{label}</span>
      <NativeSelect value={value} onChange={onChange}>
        <option value="">Choose project</option>
        {choices?.projects.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name}
          </option>
        ))}
      </NativeSelect>
    </label>
  );
}

function IconTile({ icon }: { icon: string }) {
  return (
    <span className="grid size-10 shrink-0 place-items-center rounded-lg border border-border bg-surface-raised shadow-control">
      <Icon name={icon} className="size-5" aria-hidden />
    </span>
  );
}

function IntakeTag({ children }: { children: string }) {
  return (
    <span className="inline-flex h-5 items-center rounded-full bg-state-hover px-2 text-2xs font-medium text-muted-foreground">
      {children}
    </span>
  );
}

const TEMPLATE_POINTS = [
  "Seven drafts, one for each day",
  "Every draft reviewed against your facts",
  "A delivery calendar you can download",
];

export function WorkflowIntake({ shareId }: { shareId?: string }) {
  const rpc = useRpc<typeof workflowRpcContract>();
  const navigate = experimental_useAppNavigate();
  const [text, setText] = useState("");
  const [review, setReview] = useState<Review>();
  const [choices, setChoices] = useState<SetupOptions>();
  const [project, setProject] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [requestId, setRequestId] = useState("");
  const [chosenFile, setChosenFile] = useState<ChosenFile | null>(null);

  async function inspect(source: Source) {
    setBusy(true);
    setError("");
    setReview(undefined);

    try {
      const result = await rpc.call("workflow_inspect", source);
      setReview(result);
      setRequestId(crypto.randomUUID());
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    let active = true;
    void rpc.call("workflow_options", {}).then(
      (options) => {
        if (active) setChoices(options);
      },
      (reason: unknown) => {
        if (active) setError(errorMessage(reason));
      },
    );

    return () => {
      active = false;
    };
  }, [rpc]);

  const [nativeReference, setNativeReference] =
    useState<NativeReference | null>(null);

  useEffect(() => {
    const bridge = (
      window as Window & {
        omnyoDesktop?: {
          takeWorkflowImport?(): Promise<NativeReference | null>;
          onWorkflowImport?(listener: () => void): () => void;
        };
      }
    ).omnyoDesktop;

    let active = true;

    const consume = () => {
      void bridge?.takeWorkflowImport?.().then(
        (ref) => {
          if (active && ref) setNativeReference(ref);
        },
        (reason: unknown) => {
          if (active) setError(errorMessage(reason));
        },
      );
    };

    consume();
    const unsubscribe = bridge?.onWorkflowImport?.(consume);

    return () => {
      active = false;
      unsubscribe?.();
    };
  }, []);

  async function save() {
    if (!review || !project) return;
    setBusy(true);
    setError("");

    try {
      const result = await rpc.call("workflow_install", {
        projectId: project,
        reviewId: review.reviewId,
        packageDigest: review.packageDigest,
        requestId,
      });

      navigate.toPluginPanel("automations", {
        subPath: `copies/${result.projectId}/${result.importId}`,
      });
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  function addProject() {
    setError("");

    const opened = navigate.experimental_openProjectCreator?.((created) => {
      setChoices((current) =>
        !current || current.projects.some(({ id }) => id === created.id)
          ? current
          : { ...current, projects: [...current.projects, created] },
      );
      setProject(created.id);
    });

    if (!opened) setError("Connect a machine to add a project.");
  }

  const activeShare =
    shareId ??
    (nativeReference?.kind === "share" ? nativeReference.shareId : undefined);

  const nativeFile = nativeReference?.kind === "file" ? nativeReference : null;

  return (
    <section className="mx-auto max-w-3xl space-y-6 pb-8">
      <header className="space-y-4">
        <SetupProgress current={1} />
        <div className="space-y-1">
          <h1 className="text-lead font-semibold">
            {review ? "Review before you add it" : "Import a workflow"}
          </h1>
          <p className="text-sm text-muted-foreground">
            {review
              ? "Check what it can do and what it tells the model. Adding it to a project runs nothing."
              : "Choose the built-in template or open a workflow file."}
          </p>
        </div>
      </header>
      <StepTransition
        stepKey={review ? "review" : "choose"}
        direction={review ? "forward" : "back"}
      >
        {review ? (
          <Panel label="Workflow review" className="space-y-6">
            <PackageReview review={review} />
            <div className="space-y-3 rounded-lg border border-border-seam bg-surface-recessed p-4">
              <div>
                <h3 className="text-sm font-semibold">Add it to a project</h3>
                <p className="text-xs text-muted-foreground">
                  {project
                    ? "The schedule stays off until you enable it."
                    : "Choose a project to save the copy."}
                </p>
              </div>
              <div className="flex flex-wrap items-end gap-3">
                <div className="w-full max-w-xs">
                  <ProjectSelect
                    label="Recipient project"
                    value={project}
                    choices={choices}
                    onChange={setProject}
                  />
                </div>
                {choices && navigate.experimental_openProjectCreator && (
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={addProject}
                  >
                    <Icon name="Plus" aria-hidden />
                    Add a project
                  </Button>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <Button disabled={!project || busy} onClick={() => void save()}>
                  {busy ? (
                    <Icon name="Spinner" className="animate-spin" aria-hidden />
                  ) : (
                    <Icon name="FolderPlus" aria-hidden />
                  )}
                  {review.package.flow.kind === "graph" &&
                  review.package.flow.engine === "weekly-content-feed"
                    ? "Save copy and choose sources"
                    : "Save disabled copy"}
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setReview(undefined);
                    setChosenFile(null);
                    setError("");
                  }}
                >
                  Choose another
                </Button>
              </div>
            </div>
          </Panel>
        ) : (
          <div className="space-y-4">
            {(activeShare || nativeFile) && (
              <Panel
                label="Waiting to review"
                className="flex flex-wrap items-center gap-3"
              >
                <IconTile icon={activeShare ? "Link" : "FileText"} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">
                    {activeShare
                      ? "A workflow is ready to review"
                      : `${nativeFile?.filename} is waiting`}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Review what it can do before you add it to a project.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {activeShare && (
                    <Button
                      disabled={busy}
                      onClick={() =>
                        void inspect({ kind: "link", shareId: activeShare })
                      }
                    >
                      Review workflow
                    </Button>
                  )}
                  {nativeFile && (
                    <Button
                      disabled={busy}
                      onClick={() =>
                        void inspect({ kind: "file", text: nativeFile.text })
                      }
                    >
                      Review {nativeFile.filename}
                    </Button>
                  )}
                </div>
              </Panel>
            )}
            <div className="grid gap-4 md:grid-cols-2">
              <Panel label="Built-in template" className="flex flex-col gap-4">
                <div className="flex items-start justify-between gap-3">
                  <IconTile icon="Workflow" />
                  <IntakeTag>Built-in template</IntakeTag>
                </div>
                <div className="space-y-1">
                  <h2 className="text-base font-semibold">
                    Weekly Content Feed
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    Markdown drafts for your startup’s blog or newsletter,
                    written from your own facts with your connected CLI.
                  </p>
                </div>
                <ul className="flex-1 space-y-1.5">
                  {TEMPLATE_POINTS.map((point) => (
                    <li key={point} className="flex items-center gap-2 text-sm">
                      <span className="grid size-4 shrink-0 place-items-center rounded-full bg-success/15 text-success-foreground">
                        <Icon name="Check" className="size-2.5" aria-hidden />
                      </span>
                      {point}
                    </li>
                  ))}
                </ul>
                <Button
                  variant={activeShare || nativeFile ? "outline" : "default"}
                  className="self-start"
                  disabled={busy}
                  onClick={() =>
                    void inspect({
                      kind: "template",
                      template: "weekly-content-feed",
                    })
                  }
                >
                  Review Weekly Content Feed
                  <Icon name="ArrowRight" aria-hidden />
                </Button>
              </Panel>
              <Panel
                label="Workflow file or JSON"
                className="flex flex-col gap-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <IconTile icon="FolderExport" />
                </div>
                <div className="space-y-1">
                  <h2 className="text-base font-semibold">From a file</h2>
                  <p className="text-sm text-muted-foreground">
                    Review what the workflow does before adding it.
                  </p>
                </div>
                <FileDropZone
                  accept=".omnyoworkflow"
                  maxBytes={256 * 1024}
                  file={chosenFile}
                  busy={busy && chosenFile !== null}
                  disabled={busy}
                  title="Drop a workflow file here"
                  hint=".omnyoworkflow, up to 256 KiB"
                  className="flex-1"
                  onFileReject={setError}
                  onClear={() => setChosenFile(null)}
                  onFileSelect={(file) => {
                    setChosenFile({ name: file.name, size: file.size });

                    void file
                      .arrayBuffer()
                      .then((bytes) => {
                        const content = new TextDecoder("utf-8", {
                          fatal: true,
                          ignoreBOM: true,
                        }).decode(bytes);

                        return inspect({ kind: "file", text: content });
                      })
                      .catch((reason: unknown) =>
                        setError(errorMessage(reason)),
                      );
                  }}
                />
                <details className="group" open={text ? true : undefined}>
                  <summary
                    className={`${summaryRow} h-6 w-fit rounded-md px-2 -ml-2 text-xs text-muted-foreground outline-none hover:bg-state-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring/60 pointer-coarse:h-9`}
                  >
                    <Icon name="Code" className="size-3.5" aria-hidden />
                    Paste JSON instead
                    <Icon
                      name="ChevronDown"
                      className={cn(
                        "size-3.5 shrink-0 group-open:rotate-180",
                        DISCLOSURE_CHEVRON_TRANSITION,
                      )}
                      aria-hidden
                    />
                  </summary>
                  <div className="mt-2 space-y-2">
                    <label className="block">
                      <span className="sr-only">Or paste workflow JSON</span>
                      <Textarea
                        value={text}
                        rows={5}
                        className="font-mono text-xs"
                        placeholder='{ "schemaVersion": 1, … }'
                        maxLength={256 * 1024}
                        onChange={(event) => setText(event.target.value)}
                      />
                    </label>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy || !text}
                      onClick={() => void inspect({ kind: "file", text })}
                    >
                      Review pasted workflow
                    </Button>
                  </div>
                </details>
              </Panel>
            </div>
            {busy && (
              <p
                role="status"
                className="flex items-center gap-2 text-sm text-muted-foreground"
              >
                <Icon
                  name="Spinner"
                  className="size-4 animate-spin"
                  aria-hidden
                />
                Checking the workflow…
              </p>
            )}
          </div>
        )}
      </StepTransition>
      {error && <ErrorNote>{error}</ErrorNote>}
    </section>
  );
}

function WorkflowRevisions({
  copy,
  onSaved,
}: {
  copy: Copy;
  onSaved: (copy: Copy) => void;
}) {
  const rpc = useRpc<typeof workflowRpcContract>();
  const [text, setText] = useState(() => JSON.stringify(copy.package, null, 2));
  const [keepBase, setKeepBase] = useState(true);

  const [proposal, setProposal] = useState<{
    review: Review;
    diff: RevisionComparison;
  }>();

  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  function act(run: () => Promise<void>) {
    setBusy(true);
    setError("");
    void run()
      .catch((reason: unknown) => setError(errorMessage(reason)))
      .finally(() => setBusy(false));
  }

  const target = { projectId: copy.projectId, importId: copy.importId };

  return (
    <Disclosure
      title="Edit workflow instructions"
      icon="Code"
      summary={`Revision ${copy.package.revision} · Compare a change or go back to the previous version`}
      defaultOpen={false}
    >
      <div className="space-y-3">
        <label className="block space-y-1.5">
          <span className="text-sm font-medium">Workflow JSON</span>
          <Textarea
            value={text}
            rows={12}
            className="font-mono text-xs"
            maxLength={256 * 1024}
            onChange={(event) => {
              setText(event.target.value);
              setProposal(undefined);
            }}
          />
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 size-4 accent-foreground"
            checked={keepBase}
            onChange={(event) => setKeepBase(event.target.checked)}
          />
          <span>
            <span className="block">Edit this local copy</span>
            <span className="block text-xs text-muted-foreground">
              Turn this off when the JSON is a newer version from whoever shared
              the workflow.
            </span>
          </span>
        </label>
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={busy || !text}
            variant="outline"
            size="sm"
            onClick={() =>
              act(async () => {
                const review = await rpc.call("workflow_inspect", {
                  kind: "file",
                  text,
                });

                const diff = await rpc.call("workflow_compare", {
                  ...target,
                  reviewId: review.reviewId,
                  packageDigest: review.packageDigest,
                });

                setProposal({ review, diff });
              })
            }
          >
            Compare revision
          </Button>
          <Button
            disabled={busy}
            variant="ghost"
            size="sm"
            onClick={() =>
              act(async () => {
                const review = await rpc.call("workflow_previous", target);

                const diff = await rpc.call("workflow_compare", {
                  ...target,
                  reviewId: review.reviewId,
                  packageDigest: review.packageDigest,
                });

                setKeepBase(true);
                setProposal({ review, diff });
                setText(JSON.stringify(review.package, null, 2));
              })
            }
          >
            Review previous version
          </Button>
        </div>
        {proposal && (
          <div className="space-y-4 rounded-lg border border-border bg-card p-4">
            <PackageReview review={proposal.review} />
            <dl className="grid gap-x-4 gap-y-1.5 rounded-lg bg-surface-recessed p-3 text-sm sm:grid-cols-[max-content_minmax(0,1fr)]">
              <dt className="text-muted-foreground">Changes from the sender</dt>
              <dd>{proposal.diff.incoming.join(", ") || "None"}</dd>
              <dt className="text-muted-foreground">Your changes</dt>
              <dd>{proposal.diff.modified.join(", ") || "None"}</dd>
              {proposal.diff.conflicts.length > 0 && (
                <>
                  <dt className="text-warning-text">Conflicts</dt>
                  <dd className="text-warning-text">
                    {proposal.diff.conflicts.join(", ")}
                  </dd>
                </>
              )}
            </dl>
            {keepBase || proposal.diff.applyInPlace ? (
              <Button
                disabled={busy}
                onClick={() =>
                  act(async () => {
                    const revised = await rpc.call("workflow_revise", {
                      ...target,
                      reviewId: proposal.review.reviewId,
                      packageDigest: proposal.review.packageDigest,
                      expectedPackageDigest: copy.packageDigest,
                      source: keepBase ? "local" : "shared",
                    });

                    onSaved(revised);
                    setProposal(undefined);
                  })
                }
              >
                Save version
              </Button>
            ) : (
              <p className="text-sm text-muted-foreground">
                Import this revision as a new copy to keep your edits.
              </p>
            )}
          </div>
        )}
        {error && <ErrorNote>{error}</ErrorNote>}
      </div>
    </Disclosure>
  );
}

export function WorkflowCopies({
  projectId,
  importId,
}: {
  projectId?: string;
  importId?: string;
}) {
  const rpc = useRpc<typeof workflowRpcContract>();
  const navigate = experimental_useAppNavigate();
  const [choices, setChoices] = useState<SetupOptions>();
  const [copies, setCopies] = useState<Copy[]>([]);
  const [selectedProject, setProject] = useState(projectId);
  const project = selectedProject ?? choices?.projects[0]?.id ?? "";
  const [copy, setCopy] = useState<Copy>();
  const [preview, setPreview] = useState("");
  const [localPreview, setLocalPreview] = useState(false);
  const [editing, setEditing] = useState(false);
  const [firstRun, setFirstRun] = useState("");
  const [result, setResult] = useState("");
  const [justConfirmed, setJustConfirmed] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"Setup" | "Runs">("Setup");
  const [host, setHost] = useState("");
  const [models, setModels] = useState<SetupOptions["models"]>([]);
  const [modelErrors, setModelErrors] = useState<string[]>([]);
  const [modelsLoadedFor, setModelsLoadedFor] = useState("");
  const [model, setModel] = useState("");
  const [inputs, setInputs] = useState<InputValues>({});
  const [sourceChoice, setSourceChoice] = useState<SourceChoice>("notes");

  const [verifiedReadId, setVerifiedReadId] = useState<string>();

  const [researchDraft, setResearchDraft] = useState<ResearchDraft>(() =>
    initialResearchDraft(undefined),
  );

  const [draftStarted, setDraftStarted] = useState(false);
  const sourceGroup = useId();

  useEffect(() => {
    void rpc
      .call("workflow_options", {})
      .then(setChoices, (reason: unknown) => setError(errorMessage(reason)));
  }, [rpc]);

  useEffect(() => {
    if (!project) return;
    let active = true;
    void rpc.call("workflow_list", { projectId: project }).then(
      (items) => {
        if (!active) return;
        setCopies(items);
        const selected = items.find((item) => item.importId === importId);

        const restored =
          selected && isWeeklyFeed(selected)
            ? restoreSetupDraft(selected)
            : undefined;

        setCopy(selected);
        setEditing(Boolean(restored) || !selected?.bindings);
        setDraftStarted(Boolean(restored));
        setLocalPreview(Boolean(restored?.preview));
        setPreview("");
        setFirstRun("");
        setResult("");
        setSourceChoice(restored?.sourceChoice ?? savedSourceChoice(selected));
        setResearchDraft(restored?.research ?? initialResearchDraft(selected));
        setHost(restored?.host ?? selected?.bindings?.hostId ?? "");
        setModel(
          restored?.model ??
            (selected?.bindings
              ? `${selected.bindings.providerId}:${selected.bindings.model}`
              : ""),
        );
        setInputs(restored?.inputs ?? initialInputs(selected));
      },
      (reason: unknown) => {
        if (active) setError(errorMessage(reason));
      },
    );

    return () => {
      active = false;
    };
  }, [rpc, project, importId]);

  const weekly = Boolean(copy && isWeeklyFeed(copy));

  useEffect(() => {
    if (!copy || !weekly || !draftStarted) return;

    if (
      !saveSetupDraft(copy, {
        bindingRevision: copy.bindingRevision,
        executionDigest: copy.executionDigest,
        host,
        model,
        inputs,
        sourceChoice,
        preview: localPreview,
        research: researchDraft,
      })
    ) {
      setError(
        "Could not save this draft on this device. Keep this page open to continue editing.",
      );
    }
  }, [
    copy,
    weekly,
    draftStarted,
    host,
    model,
    inputs,
    sourceChoice,
    localPreview,
    researchDraft,
  ]);

  const needsHost = Boolean(copy && !copy.bindings && !weekly);
  const showModelOptions = !weekly || localPreview;
  useEffect(() => {
    if (!host) {
      if (choices?.hosts.length === 1 && needsHost)
        setHost(choices.hosts[0].id);

      return;
    }

    if (!showModelOptions) return;

    let active = true;
    void rpc.call("workflow_options", { hostId: host }).then(
      (options) => {
        if (active) {
          setModels(options.models);
          setModelErrors(options.modelErrors ?? []);
          setModelsLoadedFor(host);

          if (options.models.length === 1 && !copy?.bindings && !weekly)
            setModel((current) => current || options.models[0].id);
        }
      },
      (reason: unknown) => {
        if (active) setError(errorMessage(reason));
      },
    );

    return () => {
      active = false;
    };
  }, [rpc, host, choices, needsHost, copy?.bindings, weekly, showModelOptions]);

  function action(run: () => Promise<void>) {
    setBusy(true);
    setError("");
    void run()
      .catch((reason: unknown) => setError(errorMessage(reason)))
      .finally(() => setBusy(false));
  }

  async function previewCopy(saved: Copy) {
    const response = await rpc.call("workflow_preview", {
      projectId: saved.projectId,
      importId: saved.importId,
    });

    if (
      response.copy.bindingRevision !== saved.bindingRevision ||
      response.copy.executionDigest !== saved.executionDigest
    ) {
      throw new Error("Workflow setup changed. Reopen the copy to review it.");
    }

    setPreview(response.example);
  }

  function previewBrief(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!copy || !canPreview) return;

    if (
      ["startup", "audience", "product-facts"].some(
        (key) =>
          copy.package.inputs.some((input) => input.id === key) &&
          !String(inputs[key] ?? "").trim(),
      )
    ) {
      setError("Enter your startup name, audience and product facts.");

      return;
    }

    setError("");
    setPreview("");
    setDraftStarted(true);
    setLocalPreview(true);
  }

  function changeHost(next: string) {
    setHost(next);
    setModel("");
    setModels([]);
    setModelErrors([]);
    setModelsLoadedFor("");
  }

  async function confirmCopy(saved: Copy) {
    try {
      setCopy(
        await rpc.call("workflow_confirm", {
          projectId: saved.projectId,
          importId: saved.importId,
          expectedRevision: saved.bindingRevision,
          executionDigest: saved.executionDigest,
        }),
      );
    } catch (reason) {
      setPreview("");
      throw reason;
    }

    setJustConfirmed(true);

    if (isWeeklyFeed(saved)) setTab("Runs");
  }

  function bind(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!copy || (weekly && (!localPreview || !canPreview))) return;

    const selected = models.find((item) => item.id === model);

    if (!selected) {
      setError("Choose an available connected CLI model.");

      return;
    }

    setPreview("");
    action(async () => {
      const saved = await rpc.call("workflow_bind", {
        projectId: copy.projectId,
        importId: copy.importId,
        expectedRevision: copy.bindingRevision,
        bindings: {
          hostId: host,
          model: selected.model,
          providerId: selected.providerId,
          inputs,
          ...(isWeeklyFeed(copy) && sourceChoice === "notes"
            ? { source: { kind: "notes" as const } }
            : researchSelection
              ? { source: researchSelection }
              : {}),
        },
      });

      discardSetupDraft(copy);
      setDraftStarted(false);
      setCopy(saved);
      setResearchDraft(initialResearchDraft(saved));
      setEditing(false);
      setLocalPreview(false);
      await previewCopy(saved);

      if (weekly) {
        if (saved.confirmation) setTab("Runs");
        else await confirmCopy(saved);
      }
    });
  }

  const approvedSource = copy?.source ?? copy?.draftSource;

  const savedResearch =
    approvedSource?.kind === "openseo" ? approvedSource : undefined;

  const pending = researchDraft.pending;

  const chosenSite = researchDraft.site.trim().toLowerCase();

  const readyResearch =
    sourceChoice === "openseo" &&
    pending?.kind === "loaded" &&
    pending.read.readId === verifiedReadId &&
    pending.connection.site === chosenSite &&
    !pending.needsReview &&
    pending.keywordIds.length > 0
      ? pending
      : undefined;

  const researchSelection: ResearchSelection | undefined = readyResearch && {
    kind: "openseo",
    readId: readyResearch.read.readId,
    keywordIds: readyResearch.keywordIds,
  };

  const selectedResearch =
    sourceChoice === "openseo"
      ? readyResearch
        ? {
            kind: "openseo" as const,
            site: readyResearch.connection.site,
            retrievedAt: readyResearch.read.retrievedAt,
            keywords: readyResearch.read.keywords.filter(({ id }) =>
              readyResearch.keywordIds.includes(id),
            ),
          }
        : researchDraft.keepSaved && savedResearch?.site === chosenSite
          ? savedResearch
          : undefined
      : undefined;

  const canPreview =
    sourceChoice !== "openseo" || selectedResearch !== undefined;

  const target = copy && { projectId: copy.projectId, importId: copy.importId };

  const step: 1 | 2 | 3 | 4 = !copy
    ? 1
    : copy.confirmation && !editing && !localPreview
      ? 4
      : !localPreview && (editing || !copy.bindings)
        ? 2
        : 3;

  const [shownStep, setShownStep] = useState(step);
  const [direction, setDirection] = useState<StepDirection>("forward");

  if (shownStep !== step) {
    setDirection(step > shownStep ? "forward" : "back");
    setShownStep(step);
  }

  if (!copy || !target) {
    return (
      <section aria-label="Installed workflows" className="space-y-4 pb-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0 max-w-xs flex-1">
            <ProjectSelect
              label="Project"
              value={project}
              choices={choices}
              onChange={setProject}
            />
          </div>
          {copies.length > 0 && (
            <Button
              variant="outline"
              onClick={() =>
                navigate.toPluginPanel("automations", { subPath: "import" })
              }
            >
              <Icon name="Plus" aria-hidden />
              Import a workflow
            </Button>
          )}
        </div>
        {project && copies.length === 0 && (
          <Panel label="No installed workflows">
            <EmptyStateBlock
              icon="Workflow"
              title="No installed workflows here yet"
              description="Import the built-in template or a workflow file to add one to this project."
              actions={
                <Button
                  size="sm"
                  onClick={() =>
                    navigate.toPluginPanel("automations", {
                      subPath: "import",
                    })
                  }
                >
                  Import a workflow
                </Button>
              }
              className="py-6"
            />
          </Panel>
        )}
        {copies.length > 0 && (
          <ul className="divide-y divide-border-seam overflow-hidden rounded-xl border border-border bg-card shadow-card">
            {copies.map((item) => (
              <li key={item.importId}>
                <button
                  type="button"
                  className="flex w-full items-center gap-3 px-4 py-3 text-left outline-none hover:bg-state-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring/60"
                  onClick={() =>
                    navigate.toPluginPanel("automations", {
                      subPath: `copies/${item.projectId}/${item.importId}`,
                    })
                  }
                >
                  <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-state-hover text-muted-foreground">
                    <Icon name="Workflow" className="size-4" aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {item.package.title}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {triggerSummary(item.package.trigger)}
                    </span>
                  </span>
                  <StatusPill {...copyStatus(item)} />
                  <Icon
                    name="ChevronRight"
                    className="size-4 text-muted-foreground"
                    aria-hidden
                  />
                </button>
              </li>
            ))}
          </ul>
        )}
        {error && <ErrorNote>{error}</ErrorNote>}
      </section>
    );
  }

  const briefOpen = !localPreview && (editing || !copy.bindings);

  const showPreview = () => action(() => previewCopy(copy));

  const boundModel = models.find(
    (item) =>
      item.providerId === copy.bindings?.providerId &&
      item.model === copy.bindings.model,
  );

  const modelDestination =
    boundModel?.name ??
    (copy.bindings
      ? `${copy.bindings.providerId === "codex" ? "Codex" : "Claude Code"} · ${copy.bindings.model}`
      : "");

  return (
    <section className="mx-auto max-w-3xl space-y-5 pb-8">
      <header className="space-y-4 border-b border-border-seam pb-4">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-lead font-semibold">
                {copy.package.title}
              </h1>
              {localPreview ? (
                <StatusPill label="Ready to approve" tone="info" />
              ) : (
                <StatusPill {...copyStatus(copy)} />
              )}
            </div>
            <p className="flex flex-wrap items-center gap-x-1.5 text-sm text-muted-foreground">
              <Icon name="Clock" className="size-3.5" aria-hidden />
              {triggerSummary(copy.package.trigger)}
              <span aria-hidden>·</span>
              {copy.package.flow.kind === "script-requirement"
                ? "Script replacement required"
                : weekly && copy.scheduleEnabled === false
                  ? "Schedule off"
                  : "Writes text only"}
            </p>
          </div>
          <SegmentedControl
            ariaLabel="Workflow views"
            size="sm"
            value={tab}
            onValueChange={setTab}
            options={[
              { value: "Setup", label: "Setup" },
              { value: "Runs", label: "Runs" },
            ]}
          />
        </div>
        {copy.graphId && <SetupProgress current={step} />}
      </header>
      {tab === "Setup" && copy.draftInputs && !copy.bindings && (
        <Alert>
          <Icon name="Info" aria-hidden />
          <AlertTitle>Your brief is still here</AlertTitle>
          <AlertDescription>
            {weekly
              ? "Preview it before choosing a device and model for approval. The schedule stays off until you turn it on."
              : "Choose a connected CLI and model, then preview and confirm it again. The schedule stays off until you turn it on."}
          </AlertDescription>
        </Alert>
      )}
      {tab === "Setup" && copy.graphId && (
        <StepTransition stepKey={String(step)} direction={direction}>
          <div className="space-y-4">
            {briefOpen ? (
              <Panel label="Brief" className="space-y-5">
                {!weekly &&
                  modelErrors.map((message) => (
                    <ErrorNote key={message}>{message}</ErrorNote>
                  ))}
                {weekly && (
                  <fieldset
                    className="space-y-3 rounded-lg border border-border p-3"
                    disabled={busy}
                  >
                    <legend className="px-1 text-sm font-semibold">
                      Source for this week
                    </legend>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {(["notes", "openseo"] as const).map((kind) => (
                        <label
                          key={kind}
                          className={cn(
                            "flex min-w-0 cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2.5 text-sm",
                            sourceChoice === kind
                              ? "border-foreground/40 bg-card font-medium shadow-control"
                              : "border-border hover:bg-state-hover",
                          )}
                        >
                          <input
                            type="radio"
                            name={sourceGroup}
                            className="size-4 shrink-0 accent-foreground"
                            checked={sourceChoice === kind}
                            onChange={() => {
                              setSourceChoice(kind);
                              setDraftStarted(true);
                            }}
                          />
                          {kind === "notes"
                            ? "Start with product notes"
                            : "Import keywords I already have in OpenSEO"}
                        </label>
                      ))}
                    </div>
                    {sourceChoice === "openseo" && (
                      <ResearchPicker
                        key={copy.importId}
                        target={target}
                        saved={savedResearch}
                        draft={researchDraft}
                        onDraftChange={setResearchDraft}
                        onReadVerified={setVerifiedReadId}
                        onOpenSettings={(event) => {
                          if (
                            !saveSetupDraft(copy, {
                              bindingRevision: copy.bindingRevision,
                              executionDigest: copy.executionDigest,
                              host,
                              model,
                              inputs,
                              sourceChoice,
                              preview: localPreview,
                              research: researchDraft,
                            })
                          ) {
                            event.preventDefault();
                            setError(
                              "Could not save this draft for your return. Open Automations settings in a separate tab.",
                            );
                          }
                        }}
                      />
                    )}
                  </fieldset>
                )}
                <BriefForm
                  copy={copy}
                  choices={choices}
                  models={models}
                  host={host}
                  model={model}
                  inputs={inputs}
                  busy={busy}
                  canPreview={canPreview}
                  onHostChange={changeHost}
                  onModelChange={setModel}
                  setInputs={(update) => {
                    setInputs(update);
                    setDraftStarted(true);
                  }}
                  onError={setError}
                  onSubmit={weekly ? previewBrief : bind}
                  onCancel={
                    copy.bindings
                      ? () => {
                          setEditing(false);
                          setHost(copy.bindings?.hostId ?? "");
                          setModel(
                            copy.bindings
                              ? `${copy.bindings.providerId}:${copy.bindings.model}`
                              : "",
                          );
                          setInputs(initialInputs(copy));
                          setSourceChoice(savedSourceChoice(copy));
                          discardSetupDraft(copy);
                          setDraftStarted(false);
                          setResearchDraft(initialResearchDraft(copy));
                        }
                      : undefined
                  }
                />
              </Panel>
            ) : (
              !localPreview && (
                <BriefSummary
                  copy={copy}
                  choices={choices}
                  models={models}
                  onEdit={() => {
                    setEditing(true);
                    setDraftStarted(true);
                    setPreview("");
                    setJustConfirmed(false);
                  }}
                />
              )
            )}
            {localPreview && (
              <Panel label="Preview" className="space-y-4">
                <WeekPreview
                  title={copy.package.title}
                  inputs={inputs}
                  keywords={selectedResearch?.keywords}
                  animate
                />
                {selectedResearch && (
                  <ResearchEvidence evidence={selectedResearch} />
                )}
                <form
                  onSubmit={bind}
                  className="space-y-3 border-t border-border-seam pt-4"
                >
                  <h3 className="text-base font-semibold">
                    Approve generation
                  </h3>
                  <fieldset disabled={busy}>
                    <DeviceModelFields
                      choices={choices}
                      models={models}
                      host={host}
                      model={model}
                      onHostChange={changeHost}
                      onModelChange={setModel}
                    />
                  </fieldset>
                  {choices?.hosts.length === 0 && (
                    <p className="text-sm text-muted-foreground">
                      Connect a device to choose a model for generation.
                    </p>
                  )}
                  {host &&
                    modelsLoadedFor === host &&
                    models.length === 0 &&
                    modelErrors.length === 0 && (
                      <p className="text-sm text-muted-foreground">
                        This device has no available Codex or Claude Code
                        models.
                      </p>
                    )}
                  {modelErrors.map((message) => (
                    <ErrorNote key={message}>{message}</ErrorNote>
                  ))}
                  <div className="flex flex-wrap items-center gap-3">
                    <Button
                      type="submit"
                      disabled={
                        busy ||
                        !canPreview ||
                        modelsLoadedFor !== host ||
                        !models.some((item) => item.id === model)
                      }
                    >
                      {busy ? (
                        <Icon
                          name="Spinner"
                          className="animate-spin"
                          aria-hidden
                        />
                      ) : (
                        <Icon name="Check" aria-hidden />
                      )}
                      Approve inputs for generation
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => {
                        setLocalPreview(false);
                        setEditing(true);
                        setError("");
                      }}
                    >
                      Edit brief
                    </Button>
                  </div>
                </form>
              </Panel>
            )}
            {copy.bindings &&
              !editing &&
              !localPreview &&
              !preview &&
              !copy.confirmation && (
                <Panel
                  label="Preview"
                  className="flex flex-wrap items-center gap-x-4 gap-y-3"
                >
                  <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-state-hover text-muted-foreground">
                    <Icon name="Calendar" className="size-5" aria-hidden />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">
                      {weekly
                        ? "Next: see your week before anything runs"
                        : "Next: preview this setup"}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {weekly
                        ? "Shows what each day will cover, built from your brief. No model runs for the preview."
                        : "Shows an example built from your brief. No model runs for the preview."}
                    </p>
                  </div>
                  <Button disabled={busy} onClick={showPreview}>
                    {busy ? (
                      <Icon
                        name="Spinner"
                        className="animate-spin"
                        aria-hidden
                      />
                    ) : (
                      <Icon name="Eye" aria-hidden />
                    )}
                    Preview
                  </Button>
                </Panel>
              )}
            {preview && (
              <Panel label="Preview" className="space-y-4">
                {weekly ? (
                  <>
                    <WeekPreview
                      title={copy.package.title}
                      inputs={copy.bindings?.inputs ?? {}}
                      keywords={savedResearch?.keywords}
                      animate
                    />
                    {savedResearch && (
                      <ResearchEvidence evidence={savedResearch} />
                    )}
                  </>
                ) : (
                  <pre className="whitespace-pre-wrap break-words rounded-lg bg-surface-recessed p-3 text-sm">
                    {preview}
                  </pre>
                )}
                <details className="group">
                  <summary
                    className={`${summaryRow} w-fit rounded-md text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring/60`}
                  >
                    <Icon name="ChevronRight" className={chevron} aria-hidden />
                    Technical details
                  </summary>
                  <div className="mt-2 space-y-2 rounded-lg border border-border-seam bg-surface-recessed p-3">
                    {weekly && (
                      <pre className="whitespace-pre-wrap break-words text-xs">
                        {preview}
                      </pre>
                    )}
                    <p className="break-all font-mono text-2xs text-muted-foreground">
                      Execution digest {copy.executionDigest}
                    </p>
                    <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground">
                      {JSON.stringify(copy.bindings, null, 2)}
                    </pre>
                  </div>
                </details>
                {copy.bindings && !copy.confirmation && (
                  <div className="flex flex-wrap items-center gap-3 border-t border-border-seam pt-4">
                    <Button
                      disabled={busy}
                      onClick={() => action(() => confirmCopy(copy))}
                    >
                      <Icon name="Check" aria-hidden />
                      {weekly
                        ? "Approve inputs for generation"
                        : "Confirm this setup"}
                    </Button>
                    <span className="text-xs text-muted-foreground">
                      {weekly
                        ? `Allow ${modelDestination} to receive the saved inputs and workflow instructions when you run it. Scheduling stays off.`
                        : "Locks in these inputs, the model and the workflow instructions. You can edit them later."}
                    </span>
                  </div>
                )}
              </Panel>
            )}
            {copy.confirmation && !editing && !localPreview && (
              <Panel
                label="Setup confirmed"
                className="flex flex-wrap items-center gap-x-4 gap-y-3 border-success/30"
              >
                <SuccessCheck animate={justConfirmed} size="lg" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">Setup confirmed</p>
                  <p className="text-xs text-muted-foreground">
                    Run it once now and read the result. Turn on the schedule
                    when you like it.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {!preview && (
                    <Button
                      variant="ghost"
                      disabled={busy}
                      onClick={showPreview}
                    >
                      Preview
                    </Button>
                  )}
                  {!weekly && (
                    <Button onClick={() => setTab("Runs")}>
                      Continue to first run
                      <Icon name="ArrowRight" aria-hidden />
                    </Button>
                  )}
                </div>
              </Panel>
            )}
          </div>
        </StepTransition>
      )}
      {tab === "Setup" && !copy.graphId && (
        <Alert variant="warning">
          <Icon name="AlertTriangle" aria-hidden />
          <AlertTitle>This workflow can’t run yet</AlertTitle>
          <AlertDescription>
            It was shared with a local script, which Omnyo does not run. Replace
            the script requirement with a supported workflow action to continue.
          </AlertDescription>
        </Alert>
      )}
      {tab === "Setup" && (
        <WorkflowRevisions
          key={copy.packageDigest}
          copy={copy}
          onSaved={(saved) => {
            setCopy(saved);
            setPreview("");
            setLocalPreview(false);
            setInputs(initialInputs(saved));
            setSourceChoice(savedSourceChoice(saved));
            discardSetupDraft(copy);
            setDraftStarted(false);
            setResearchDraft(initialResearchDraft(saved));
          }}
        />
      )}
      {tab === "Runs" && (
        <>
          <Panel label="Run and read" className="space-y-4">
            <div className="flex items-start gap-3">
              <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-state-hover text-muted-foreground">
                <Icon name="Play" className="size-5" aria-hidden />
              </span>
              <div className="min-w-0">
                <h2 className="text-base font-semibold">Run and read</h2>
                <p className="text-sm text-muted-foreground">
                  {weekly
                    ? "Each run writes seven drafts with your selected CLI and reviews every one before saving it."
                    : "Each run uses only the inputs you confirmed and saves its text with the run."}
                </p>
              </div>
            </div>
            {!copy.confirmation && (
              <Alert variant="warning">
                <Icon name="AlertTriangle" aria-hidden />
                <AlertTitle>Confirm your setup first</AlertTitle>
                <AlertDescription>
                  Runs use the brief and model you confirm.{" "}
                  <Button
                    variant="link"
                    className="h-auto p-0 text-sm"
                    onClick={() => setTab("Setup")}
                  >
                    Go to setup
                  </Button>
                </AlertDescription>
              </Alert>
            )}
            <div className="flex flex-wrap items-center gap-2 border-t border-border-seam pt-4">
              <Button
                disabled={busy || !copy.confirmation}
                onClick={() =>
                  action(async () => {
                    const response = await rpc.call("workflow_run", {
                      ...target,
                      requestId: crypto.randomUUID(),
                    });

                    setFirstRun(response.run.id);
                    setResult("");
                    setCopy(
                      (current) =>
                        current && {
                          ...current,
                          automationId: response.run.automationId,
                        },
                    );
                  })
                }
              >
                <Icon name="Play" aria-hidden />
                Run now
              </Button>
              <Button
                variant="outline"
                disabled={
                  busy ||
                  !copy.confirmation ||
                  copy.scheduleEnabled ||
                  copy.package.trigger.kind === "manual"
                }
                onClick={() =>
                  action(async () => {
                    setCopy(await rpc.call("workflow_enable", target));
                    setResult(
                      `Schedule turned on. ${triggerSummary(copy.package.trigger)}.`,
                    );
                  })
                }
              >
                <Icon name="Clock" aria-hidden />
                {copy.scheduleEnabled ? "Schedule enabled" : "Enable schedule"}
              </Button>
              {result ? (
                <p
                  role="status"
                  className="inline-flex items-center gap-1.5 text-xs text-success-foreground"
                >
                  <SuccessCheck animate size="sm" />
                  {result}
                </p>
              ) : (
                copy.confirmation && (
                  <span className="text-xs text-muted-foreground">
                    {copy.package.trigger.kind === "manual"
                      ? "This workflow runs only when you start it."
                      : weekly
                        ? "Scheduled runs reuse the approved brief. Edit and approve the brief to change its sources."
                        : triggerSummary(copy.package.trigger)}
                  </span>
                )
              )}
            </div>
          </Panel>
          <WorkflowRuns key={copy.importId} copy={copy} firstRun={firstRun} />
        </>
      )}
      {error && <ErrorNote>{error}</ErrorNote>}
    </section>
  );
}

export function AutomationAuthoring({
  automation,
}: {
  automation: AutomationResponse;
}) {
  const rpc = useRpc<typeof automationRpcContract>();
  const [name, setName] = useState(automation.name);

  const [cron, setCron] = useState(
    automation.trigger.triggerType === "schedule"
      ? automation.trigger.cron
      : "",
  );

  const [timezone, setTimezone] = useState(
    automation.trigger.triggerType === "schedule"
      ? automation.trigger.timezone
      : "",
  );

  const [once, setOnce] = useState(
    automation.trigger.triggerType === "once"
      ? new Date(automation.trigger.runAt).toISOString()
      : "",
  );

  const original =
    automation.execution.mode === "agent"
      ? automation.execution.prompt
      : automation.execution.mode === "script"
        ? (automation.execution.script ?? "")
        : "";

  const [body, setBody] = useState(original);
  const [saving, setSaving] = useState(false);

  const [status, setStatus] = useState<
    { ok: true } | { ok: false; message: string } | null
  >(null);

  const schedule = automation.trigger.triggerType === "schedule";

  if (automation.execution.mode === "workflow") return null;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setStatus(null);
    void rpc
      .call("automations_update", {
        projectId: automation.projectId,
        automationId: automation.id,
        ...(name !== automation.name ? { name } : {}),
        ...(schedule &&
        automation.trigger.triggerType === "schedule" &&
        (cron !== automation.trigger.cron ||
          timezone !== automation.trigger.timezone)
          ? { trigger: { triggerType: "schedule" as const, cron, timezone } }
          : !schedule &&
              automation.trigger.triggerType === "once" &&
              Date.parse(once) !== automation.trigger.runAt
            ? {
                trigger: {
                  triggerType: "once" as const,
                  runAt: Date.parse(once),
                },
              }
            : {}),
        ...(body && body !== original
          ? automation.execution.mode === "agent"
            ? { agent: { prompt: body } }
            : { script: { script: body } }
          : {}),
      })
      .then(
        () => setStatus({ ok: true }),
        (error: unknown) =>
          setStatus({ ok: false, message: errorMessage(error) }),
      )
      .finally(() => setSaving(false));
  }

  const fieldLabel = "block text-sm font-medium";

  return (
    <div className="my-4">
      <Disclosure
        title="Edit trigger and action"
        icon="Edit"
        summary={
          schedule ? `${cron} · ${timezone}` : "Runs once at the time you set"
        }
        defaultOpen={false}
      >
        <form className="space-y-4" onSubmit={submit}>
          <label className="block space-y-1.5">
            <span className={fieldLabel}>Workflow name</span>
            <Input
              value={name}
              required
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <fieldset className="space-y-3 rounded-lg border border-border-seam bg-surface-recessed p-3">
              <legend className="flex items-center gap-1.5 px-1 text-xs font-medium text-muted-foreground">
                <Icon name="Clock" className="size-3.5" aria-hidden />
                When it runs
              </legend>
              {schedule ? (
                <>
                  <label className="block space-y-1.5">
                    <span className={fieldLabel}>Cron schedule</span>
                    <Input
                      value={cron}
                      required
                      className="font-mono"
                      onChange={(event) => setCron(event.target.value)}
                    />
                  </label>
                  <label className="block space-y-1.5">
                    <span className={fieldLabel}>Timezone</span>
                    <Input
                      value={timezone}
                      required
                      onChange={(event) => setTimezone(event.target.value)}
                    />
                  </label>
                </>
              ) : (
                <label className="block space-y-1.5">
                  <span className={fieldLabel}>Run at (ISO 8601)</span>
                  <Input
                    value={once}
                    required
                    className="font-mono"
                    onChange={(event) => setOnce(event.target.value)}
                  />
                </label>
              )}
            </fieldset>
            <fieldset className="space-y-3 rounded-lg border border-border-seam bg-surface-recessed p-3">
              <legend className="flex items-center gap-1.5 px-1 text-xs font-medium text-muted-foreground">
                <Icon
                  name={
                    automation.execution.mode === "agent"
                      ? "MessageSquare"
                      : "Terminal"
                  }
                  className="size-3.5"
                  aria-hidden
                />
                What it does
              </legend>
              <label className="block space-y-1.5">
                <span className={fieldLabel}>
                  {automation.execution.mode === "agent" ? "Prompt" : "Script"}
                </span>
                <Textarea
                  value={body}
                  rows={7}
                  className={
                    automation.execution.mode === "script"
                      ? "font-mono text-xs"
                      : undefined
                  }
                  onChange={(event) => setBody(event.target.value)}
                />
              </label>
            </fieldset>
          </div>
          <div className="flex flex-wrap items-center gap-3 border-t border-border-seam pt-4">
            <Button type="submit" disabled={saving}>
              {saving && (
                <Icon name="Spinner" className="animate-spin" aria-hidden />
              )}
              Save workflow
            </Button>
            {status?.ok && (
              <p
                role="status"
                className="inline-flex items-center gap-1.5 text-xs text-success-foreground"
              >
                <SuccessCheck animate size="sm" />
                Workflow saved.
              </p>
            )}
          </div>
          {status && !status.ok && <ErrorNote>{status.message}</ErrorNote>}
        </form>
      </Disclosure>
    </div>
  );
}

export function WorkflowGraphs() {
  const rpc = useRpc<typeof workflowRpcContract>();

  const [graphs, setGraphs] =
    useState<
      z.output<(typeof workflowRpcContract)["workflow_graphs"]["output"]>
    >();

  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [request, setRequest] = useState(0);
  useEffect(() => {
    let active = true;
    void rpc.call("workflow_graphs", {}).then(
      (value) => {
        if (active) setGraphs(value);
      },
      (reason: unknown) => {
        if (active) setError(errorMessage(reason));
      },
    );

    return () => {
      active = false;
    };
  }, [rpc, request]);

  const machinesPath = "/plugins/state-machines/machines";
  const search = query.trim().toLowerCase();

  const listed = graphs
    ?.filter(({ name }) => name.toLowerCase().includes(search))
    .sort(
      (left, right) =>
        Number(right.openAttentionCount > 0) -
          Number(left.openAttentionCount > 0) ||
        left.name.localeCompare(right.name),
    );

  return (
    <section aria-label="State machines" className="space-y-4 pb-8">
      <div className="flex flex-wrap items-center gap-2">
        <Button asChild>
          <UrlLink href={`${machinesPath}/new`}>
            <Icon name="Plus" aria-hidden />
            New state machine
          </UrlLink>
        </Button>
        <Button variant="outline" asChild>
          <UrlLink href={`${machinesPath}/attention`}>Needs attention</UrlLink>
        </Button>
      </div>
      {graphs === undefined && !error && (
        <ResourceListState state="loading" message="Loading state machines" />
      )}
      {error && (
        <ResourceListState
          state="error"
          message={error}
          onRetry={() => {
            setError("");
            setRequest((value) => value + 1);
          }}
        />
      )}
      {graphs?.length === 0 && (
        <Panel label="No state machines">
          <EmptyStateBlock
            icon="Workflow"
            title="No state machines yet"
            description="Build a graph for work that needs several steps, branches or retries."
            className="py-6"
          />
        </Panel>
      )}
      {graphs && graphs.length > 0 && (
        <ResourceToolbar
          searchValue={query}
          searchPlaceholder="Search state machines"
          onSearchChange={setQuery}
        />
      )}
      {graphs && graphs.length > 0 && listed?.length === 0 && (
        <ResourceListState
          state="empty"
          message="No state machines match your search."
        />
      )}
      {listed && listed.length > 0 && (
        <ul className="divide-y divide-border-seam overflow-hidden rounded-xl border border-border bg-card shadow-card">
          {listed.map((graph) => {
            const run =
              graph.instances.find(
                ({ lifecycle }) => lifecycle === "running",
              ) ??
              graph.instances.find(({ lifecycle }) => lifecycle === "paused") ??
              graph.instances[0];

            return (
              <li key={graph.machineId}>
                <UrlLink
                  className="flex w-full items-center gap-3 px-4 py-3 text-left outline-none hover:bg-state-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring/60"
                  href={`${machinesPath}/m/${encodeURIComponent(graph.machineId)}`}
                >
                  <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-state-hover text-muted-foreground">
                    <Icon name="Workflow" className="size-4" aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {graph.name}
                    </span>
                    {run && (
                      <span className="block truncate text-xs text-muted-foreground">
                        <span className="capitalize">{run.lifecycle}</span> ·{" "}
                        {run.stateTitle}
                      </span>
                    )}
                  </span>
                  <StatusPill
                    label={
                      graph.openAttentionCount > 0
                        ? "Needs you"
                        : graph.latestVersionNumber
                          ? `Version ${graph.latestVersionNumber}${graph.draftChangeCount > 0 ? " · Edited" : ""}`
                          : "Draft"
                    }
                    tone={graph.openAttentionCount > 0 ? "warning" : "muted"}
                  />
                  <Icon
                    name="ChevronRight"
                    className="size-4 shrink-0 text-muted-foreground"
                    aria-hidden
                  />
                </UrlLink>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
