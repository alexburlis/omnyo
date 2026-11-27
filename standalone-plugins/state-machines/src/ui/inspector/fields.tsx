import { type KeyboardEvent, type ReactNode, useEffect, useId, useState } from "react";

export function CommitInput({
  label,
  value,
  onCommit,
  disabled,
  hint,
  error,
  mono = false,
  maxLength,
  placeholder,
  inputRef,
}: {
  label: string;
  value: string;
  onCommit(value: string): void;
  disabled: boolean;
  hint?: string;
  error?: string | null;
  mono?: boolean;
  maxLength?: number;
  placeholder?: string;
  inputRef?: (element: HTMLInputElement | null) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState(value);

  useEffect(() => setDraft(value), [value]);

  const commit = () => {
    if (draft !== value) onCommit(draft);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commit();
    } else if (event.key === "Escape") {
      setDraft(value);
    }
  };

  return (
    <div className={`stm-field${error ? " stm-field--error" : ""}`}>
      <label className="stm-field-label" htmlFor={id}>
        {label}
      </label>
      <input
        ref={inputRef}
        id={id}
        className={`stm-input${mono ? " stm-mono" : ""}`}
        value={draft}
        disabled={disabled}
        maxLength={maxLength}
        placeholder={placeholder}
        aria-invalid={error ? true : undefined}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={onKeyDown}
      />
      {error ? (
        <p className="stm-field-error">{error}</p>
      ) : hint === undefined ? null : (
        <p className="stm-field-hint">{hint}</p>
      )}
    </div>
  );
}

export function CommitTextarea({
  label,
  value,
  onCommit,
  disabled,
  hint,
  error,
  rows = 4,
  maxLength,
}: {
  label: string;
  value: string;
  onCommit(value: string): void;
  disabled: boolean;
  hint?: string;
  error?: string | null;
  rows?: number;
  maxLength?: number;
}) {
  const id = useId();
  const [draft, setDraft] = useState(value);

  useEffect(() => setDraft(value), [value]);

  return (
    <div className={`stm-field${error ? " stm-field--error" : ""}`}>
      <label className="stm-field-label" htmlFor={id}>
        {label}
      </label>
      <textarea
        id={id}
        className="stm-input stm-textarea"
        rows={rows}
        value={draft}
        disabled={disabled}
        maxLength={maxLength}
        aria-invalid={error ? true : undefined}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => draft !== value && onCommit(draft)}
      />
      {error ? (
        <p className="stm-field-error">{error}</p>
      ) : hint === undefined ? null : (
        <p className="stm-field-hint">{hint}</p>
      )}
    </div>
  );
}

export function SelectField<Value extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
  hint,
  error,
  placeholder,
}: {
  label: string;
  value: Value | null;
  options: readonly { value: Value; label: string; disabled?: boolean }[];
  onChange(value: Value): void;
  disabled: boolean;
  hint?: string;
  error?: string | null;
  placeholder?: string;
}) {
  const id = useId();

  return (
    <div className={`stm-field${error ? " stm-field--error" : ""}`}>
      <label className="stm-field-label" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        className="stm-input"
        value={value ?? ""}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        onChange={(event) => {
          const next = options.find((option) => option.value === event.target.value);

          if (next !== undefined) onChange(next.value);
        }}
      >
        {value === null ? <option value="">{placeholder ?? "Choose…"}</option> : null}
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
      {error ? (
        <p className="stm-field-error">{error}</p>
      ) : hint === undefined ? null : (
        <p className="stm-field-hint">{hint}</p>
      )}
    </div>
  );
}

export function RadioField<Value extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
  hint,
}: {
  label: string;
  value: Value;
  options: readonly { value: Value; label: string; hint?: string }[];
  onChange(value: Value): void;
  disabled: boolean;
  hint?: string;
}) {
  const name = useId();

  return (
    <fieldset className="stm-field stm-radio-group" disabled={disabled}>
      <legend className="stm-field-label">{label}</legend>
      {options.map((option) => (
        <label key={option.value} className="stm-radio">
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={value === option.value}
            onChange={() => onChange(option.value)}
          />
          <span>
            {option.label}
            {option.hint === undefined ? null : (
              <span className="stm-text-muted stm-text-xs"> · {option.hint}</span>
            )}
          </span>
        </label>
      ))}
      {hint === undefined ? null : <p className="stm-field-hint">{hint}</p>}
    </fieldset>
  );
}

export function DurationField({
  label,
  valueMs,
  onCommit,
  disabled,
  minMs,
  maxMs,
  hint,
}: {
  label: string;
  valueMs: number;
  onCommit(ms: number): void;
  disabled: boolean;
  minMs: number;
  maxMs: number;
  hint?: string;
}) {
  const id = useId();
  const [draft, setDraft] = useState(String(Math.round(valueMs / 60_000)));

  useEffect(() => setDraft(String(Math.round(valueMs / 60_000))), [valueMs]);

  const minutes = Number(draft);
  const valid = Number.isFinite(minutes) && minutes * 60_000 >= minMs && minutes * 60_000 <= maxMs;

  const error = valid
    ? null
    : `Use ${Math.round(minMs / 60_000)}–${Math.round(maxMs / 60_000)} minutes.`;

  return (
    <div className={`stm-field${error ? " stm-field--error" : ""}`}>
      <label className="stm-field-label" htmlFor={id}>
        {label} (minutes)
      </label>
      <input
        id={id}
        className="stm-input stm-input--short"
        inputMode="numeric"
        value={draft}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() =>
          valid &&
          Math.round(minutes * 60_000) !== valueMs &&
          onCommit(Math.round(minutes * 60_000))
        }
      />
      {error ? (
        <p className="stm-field-error">{error}</p>
      ) : hint === undefined ? null : (
        <p className="stm-field-hint">{hint}</p>
      )}
    </div>
  );
}

export function Section({
  title,
  children,
  defaultOpen = true,
}: {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();

  return (
    <section className="stm-inspector-section">
      <h3 className="stm-h3">
        <button
          type="button"
          className="stm-section-toggle"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((value) => !value)}
        >
          {title}
        </button>
      </h3>
      {open ? (
        <div id={id} className="stm-inspector-section-body">
          {children}
        </div>
      ) : null}
    </section>
  );
}

export function problemFor(
  problems: readonly { path: string; message: string; severity: string }[],
  path: string,
): string | null {
  const match = problems.find((problem) => problem.path === path && problem.severity === "error");

  return match?.message ?? null;
}
