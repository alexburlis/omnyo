import { experimental_useAppContext, useSdk } from "@omnyo/plugin-sdk/app";
import { type FormEvent, useEffect, useId, useState } from "react";

import { errorFromCatch, newRequestId, type SmError, useSmClient } from "../data/client.js";
import { Button, ErrorAlert, Field } from "../primitives.js";
import { Page, useGo } from "../shell.js";

type Template = "blank" | "release-loop" | "local-check-loop";

const TEMPLATES: { value: Template; title: string; body: string }[] = [
  { value: "blank", title: "Blank machine", body: "Start with an empty graph." },
  {
    value: "release-loop",
    title: "Release loop template",
    body: "Wait for commits, gate, build, fix and ask a person.",
  },
  {
    value: "local-check-loop",
    title: "Local check loop",
    body: "Run a local check on every new commit.",
  },
];

interface ProjectOption {
  id: string;
  name: string;
}

export function NewMachine() {
  const context = experimental_useAppContext();
  const sdk = useSdk();
  const client = useSmClient();
  const go = useGo();
  const [template, setTemplate] = useState<Template>("blank");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [projectId, setProjectId] = useState<string | null>(context.projectId);
  const [projects, setProjects] = useState<ProjectOption[] | null>(null);
  const [error, setError] = useState<SmError | null>(null);
  const [pending, setPending] = useState(false);
  const [requestId] = useState(newRequestId);
  const nameId = useId();
  const descriptionId = useId();
  const projectFieldId = useId();

  useEffect(() => {
    if (context.projectId !== null) return;

    let cancelled = false;

    sdk.projects
      .list()
      .then((list) => {
        if (!cancelled)
          setProjects(list.map((project) => ({ id: project.id, name: project.name })));
      })
      .catch((caught: Error) => {
        if (!cancelled) setError(errorFromCatch(caught));
      });

    return () => {
      cancelled = true;
    };
  }, [context.projectId, sdk]);

  const nameError =
    name.trim().length === 0
      ? "Enter a title."
      : name.length > 60
        ? "Use 60 characters or fewer."
        : null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();

    if (nameError !== null || projectId === null) return;

    setPending(true);
    setError(null);

    try {
      const created = await client.call("sm_machine_create", {
        projectId,
        name: name.trim(),
        description: description.trim(),
        template,
        requestId,
      });

      go({ screen: "draft", machineId: created.machineId, selection: null }, { replace: true });
    } catch (caught) {
      setError(errorFromCatch(caught instanceof Error ? caught : null));
      setPending(false);
    }
  };

  return (
    <Page
      crumbs={[
        { label: "State machines", route: { screen: "list" } },
        { label: "New machine", route: null },
      ]}
      title="New machine"
    >
      <form className="stm-form" onSubmit={(event) => void submit(event)}>
        <fieldset className="stm-choice-cards">
          <legend className="stm-field-label">Start from</legend>
          {TEMPLATES.map((option) => (
            <label
              key={option.value}
              className={`stm-choice-card${template === option.value ? " stm-choice-card--selected" : ""}`}
            >
              <input
                type="radio"
                name="template"
                value={option.value}
                checked={template === option.value}
                onChange={() => setTemplate(option.value)}
              />
              <span className="stm-text-strong">{option.title}</span>
              <span className="stm-text-muted">{option.body}</span>
            </label>
          ))}
        </fieldset>
        {context.projectId === null ? (
          <Field label="Project" htmlFor={projectFieldId}>
            <select
              id={projectFieldId}
              className="stm-input"
              value={projectId ?? ""}
              onChange={(event) =>
                setProjectId(event.target.value.length > 0 ? event.target.value : null)
              }
            >
              <option value="">
                {projects === null ? "Loading projects…" : "Choose a project"}
              </option>
              {(projects ?? []).map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
        <Field label="Title" htmlFor={nameId} error={name.length > 0 ? nameError : null}>
          <input
            id={nameId}
            className="stm-input"
            value={name}
            maxLength={60}
            required
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field label="Description" htmlFor={descriptionId} hint="Optional.">
          <input
            id={descriptionId}
            className="stm-input"
            value={description}
            maxLength={140}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>
        {error === null ? null : <ErrorAlert error={error} subject="project" />}
        <div className="stm-row">
          <Button
            type="submit"
            variant="primary"
            disabled={nameError !== null || projectId === null}
            pending={pending}
          >
            Create
          </Button>
          <Button variant="ghost" onClick={() => go({ screen: "list" })}>
            Cancel
          </Button>
        </div>
      </form>
    </Page>
  );
}
