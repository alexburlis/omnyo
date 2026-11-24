import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import {
  createInitialFormState,
  type Question,
  type QuestionAnswerState,
  type QuestionFormState,
} from "./question-form-state";

interface QuestionDraft {
  formState: QuestionFormState;
  currentIndex: number;
}

const CHANGE_EVENT = "omnyo.question-draft.changed";

const STORAGE_PREFIX = "omnyo.question-draft.v1:";

const LEGACY_STORAGE_PREFIX = "bb.question-draft.v1:";

function legacyStorageKey(storageKey: string): string {
  return `${LEGACY_STORAGE_PREFIX}${storageKey.slice(STORAGE_PREFIX.length)}`;
}

function readStoredDraft(storageKey: string): string | null {
  return (
    window.localStorage.getItem(storageKey) ??
    window.localStorage.getItem(legacyStorageKey(storageKey))
  );
}

const drafts = new Map<
  string,
  { raw: string | null; signature: string; draft: QuestionDraft }
>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function questionSignatures(
  questions: readonly Question[],
): Record<string, string> {
  return Object.fromEntries(
    questions.map((question) => [question.id, questionSignature(question)]),
  );
}

function questionSignature(question: Question): string {
  const options = question.options.map(({ recommended, ...option }) =>
    recommended
      ? { ...option, label: `${option.label} (Recommended)` }
      : option,
  );

  return JSON.stringify({ ...question, options });
}

function parseAnswerState(
  answer: unknown,
  question: Question,
): QuestionAnswerState | null {
  if (
    !isRecord(answer) ||
    !Array.isArray(answer.selected) ||
    !answer.selected.every(
      (selected: unknown) => typeof selected === "string",
    ) ||
    typeof answer.otherSelected !== "boolean" ||
    typeof answer.otherText !== "string"
  )
    return null;

  return {
    selected: answer.selected.filter((selected: string) =>
      question.options.some((option) => option.value === selected),
    ),
    otherSelected: answer.otherSelected,
    otherText: answer.otherText,
  };
}

function storedSignatures(
  value: Record<string, unknown>,
): Record<string, unknown> | null {
  if (value.version === 2)
    return isRecord(value.questions) ? value.questions : null;

  if (value.version !== 1 || typeof value.signature !== "string") return null;
  const questions: unknown = JSON.parse(value.signature);

  if (!Array.isArray(questions)) return null;

  return Object.fromEntries(
    questions.flatMap((question: unknown) =>
      isRecord(question) && typeof question.id === "string"
        ? [[question.id, JSON.stringify(question)]]
        : [],
    ),
  );
}

function parseDraft(
  raw: string | null,
  questions: readonly Question[],
): QuestionDraft | null {
  if (raw === null) return null;

  try {
    const value: unknown = JSON.parse(raw);
    const signatures = isRecord(value) ? storedSignatures(value) : null;

    if (
      !isRecord(value) ||
      signatures === null ||
      !isRecord(value.formState) ||
      typeof value.currentIndex !== "number" ||
      !Number.isInteger(value.currentIndex) ||
      value.currentIndex < 0
    )
      return null;
    const formState = createInitialFormState(questions);
    let restored = false;

    for (const question of questions) {
      if (signatures[question.id] !== questionSignature(question)) continue;
      const answer = parseAnswerState(value.formState[question.id], question);

      if (answer === null) continue;
      formState[question.id] = answer;
      restored = true;
    }

    if (!restored) return null;

    const currentIndex = questions.findIndex(
      (question) => question.id === value.currentQuestionId,
    );

    return {
      formState,
      currentIndex:
        currentIndex >= 0
          ? currentIndex
          : Math.max(0, Math.min(value.currentIndex, questions.length - 1)),
    };
  } catch {
    return null;
  }
}

export function useQuestionFormDraft(
  draftKey: string | undefined,
  questions: readonly Question[],
) {
  const storageKey = draftKey ? `${STORAGE_PREFIX}${draftKey}` : null;
  const signature = JSON.stringify(questions);

  const initialDraft = useMemo(
    () => ({ formState: createInitialFormState(questions), currentIndex: 0 }),
    [questions],
  );

  const [localDraft, setLocalDraft] = useState(initialDraft);

  const [retainedDraft, setRetainedDraft] = useState<QuestionDraft | null>(
    null,
  );

  const getSnapshot = useCallback((): QuestionDraft => {
    if (!storageKey || typeof window === "undefined") return initialDraft;
    const cached = drafts.get(storageKey);
    let raw: string | null;

    try {
      raw = readStoredDraft(storageKey);
    } catch {
      return cached?.signature === signature ? cached.draft : initialDraft;
    }

    if (cached?.raw === raw && cached.signature === signature)
      return cached.draft;
    const draft = parseDraft(raw, questions) ?? initialDraft;
    drafts.set(storageKey, { raw, signature, draft });

    return draft;
  }, [storageKey, questions, signature, initialDraft]);

  const subscribe = useCallback(
    (listener: () => void) => {
      if (!storageKey || typeof window === "undefined") return () => {};

      window.addEventListener(CHANGE_EVENT, listener);
      window.addEventListener("storage", listener);

      return () => {
        window.removeEventListener(CHANGE_EVENT, listener);
        window.removeEventListener("storage", listener);
      };
    },
    [storageKey],
  );

  const storedDraft = useSyncExternalStore(
    subscribe,
    getSnapshot,
    () => initialDraft,
  );

  const updateDraft = (update: (current: QuestionDraft) => QuestionDraft) => {
    if (!storageKey || typeof window === "undefined") {
      setLocalDraft(update);

      return;
    }

    const draft = update(getSnapshot());

    const raw = JSON.stringify({
      version: 2,
      questions: questionSignatures(questions),
      formState: draft.formState,
      currentIndex: draft.currentIndex,
      currentQuestionId: questions[draft.currentIndex]?.id ?? null,
    });

    let storedRaw: string | null = null;

    try {
      storedRaw = readStoredDraft(storageKey);
      window.localStorage.setItem(storageKey, raw);
      storedRaw = raw;
    } catch {}

    drafts.set(storageKey, { raw: storedRaw, signature, draft });
    window.dispatchEvent(new Event(CHANGE_EVENT));
  };

  const draft = retainedDraft ?? (storageKey ? storedDraft : localDraft);

  return {
    ...draft,
    setFormState: (update: (state: QuestionFormState) => QuestionFormState) =>
      updateDraft((current) => ({
        ...current,
        formState: update(current.formState),
      })),
    setCurrentIndex: (update: number | ((index: number) => number)) =>
      updateDraft((current) => ({
        ...current,
        currentIndex:
          typeof update === "number" ? update : update(current.currentIndex),
      })),
    clearDraft: () => {
      setRetainedDraft(draft);

      if (
        !storageKey ||
        typeof window === "undefined" ||
        JSON.stringify(getSnapshot().formState) !==
          JSON.stringify(draft.formState)
      )
        return;

      try {
        window.localStorage.removeItem(storageKey);
        window.localStorage.removeItem(legacyStorageKey(storageKey));
      } catch {}

      drafts.delete(storageKey);
    },
  };
}
