import type {
  Question,
  QuestionOption,
  QuestionAnswer,
} from "./question-form-state";
import {
  useQuestionFormHost,
  type QuestionShortcut,
} from "./question-form-host";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { Button } from "./button";
import { Icon } from "./icon";
import { VoiceInputTextarea } from "./voice-input-textarea";
import { usePointerCoarse } from "./hooks/use-pointer-coarse";
import { cn } from "../../lib/utils";
import { LIST_HOVER_TRANSITION } from "./motion";
import {
  answerStateFor,
  buildQuestionAnswers,
  isQuestionAnswered,
  resolveQuestionShortcutChoice,
  type QuestionAnswerState,
  type QuestionFormState,
} from "./question-form-state";
import { useQuestionFormDraft } from "./question-form-draft";

const OTHER_OPTION_LABEL = "Other…";

const FREE_TEXT_MIN_HEIGHT = 84;

const FREE_TEXT_MAX_HEIGHT = 158;

const PREVIEW_MAX_HEIGHT = 220;

const ADVANCE_DELAY_MS = 180;

const RADIO_ARROW_DIRECTION: Readonly<Record<string, number>> = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
};

interface QuestionOptionRowProps {
  checked: boolean;
  label: string;
  description?: string;
  recommended?: boolean;
  multiSelect: boolean;
  onSelect: () => void;
  shortcut?: QuestionShortcut;
  tabIndex?: number;
}

function useAutoGrow(
  ref: RefObject<HTMLTextAreaElement | null>,
  { minHeight, maxHeight }: { minHeight: number; maxHeight: number },
) {
  return useCallback(
    (textarea?: HTMLTextAreaElement | null) => {
      const element = textarea ?? ref.current;

      if (!element) return;
      const parent = element.parentElement;
      const parentMinHeight = parent?.style.minHeight ?? "";

      if (parent) parent.style.minHeight = `${parent.offsetHeight}px`;
      element.style.height = "auto";
      element.style.height = `${Math.min(
        Math.max(element.scrollHeight, minHeight),
        maxHeight,
      )}px`;

      if (parent) parent.style.minHeight = parentMinHeight;
    },
    [maxHeight, minHeight, ref],
  );
}

function QuestionOptionRow({
  checked,
  label,
  description,
  recommended,
  multiSelect,
  onSelect,
  shortcut,
  tabIndex,
}: QuestionOptionRowProps) {
  const descriptionId = useId();

  return (
    <button
      type="button"
      role={multiSelect ? undefined : "radio"}
      aria-label={recommended ? `${label}, recommended` : label}
      aria-describedby={description ? descriptionId : undefined}
      aria-checked={multiSelect ? undefined : checked}
      aria-pressed={multiSelect ? checked : undefined}
      tabIndex={tabIndex}
      data-question-option=""
      aria-keyshortcuts={shortcut?.ariaKeyshortcuts}
      onClick={onSelect}
      className={cn(
        "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
        LIST_HOVER_TRANSITION,
        checked ? "bg-surface-selected" : "hover:bg-state-hover",
      )}
    >
      <span
        className={cn(
          "mt-0.5 flex size-4 shrink-0 items-center justify-center border",
          multiSelect ? "rounded" : "rounded-full",
          checked ? "border-primary text-primary" : "border-input",
        )}
      >
        {checked &&
          (multiSelect ? (
            <Icon name="Check" className="size-3" aria-hidden />
          ) : (
            <span className="size-2 rounded-full bg-current" aria-hidden />
          ))}
      </span>
      <span className="min-w-0 flex-1">
        <span className="text-sm text-foreground [overflow-wrap:anywhere]">
          {label}
        </span>
        {recommended ? (
          <span className="ml-2 text-xs text-muted-foreground">
            Recommended
          </span>
        ) : null}
        {description ? (
          <span
            id={descriptionId}
            className="mt-0.5 block text-xs leading-snug text-muted-foreground"
          >
            {description}
          </span>
        ) : null}
      </span>
      {shortcut ? (
        <kbd
          aria-hidden="true"
          className="shrink-0 text-xs tabular-nums text-subtle-foreground"
        >
          {shortcut.label}
        </kbd>
      ) : null}
    </button>
  );
}

function QuestionOptionPreview({
  preview,
  renderRichPreview,
}: {
  preview: string;
  renderRichPreview?: QuestionFormProps["renderRichPreview"];
}) {
  const rich = renderRichPreview?.(preview);

  if (rich) {
    return (
      <div className="mx-2.5 my-1 max-h-80 overflow-auto rounded-md border border-border bg-surface-raised px-2.5 py-2">
        {rich}
      </div>
    );
  }

  return (
    <pre
      className="mx-2.5 mb-1 mt-1 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-surface-raised px-2.5 py-2 font-mono text-xs leading-relaxed text-foreground"
      style={{ maxHeight: `${PREVIEW_MAX_HEIGHT}px` }}
    >
      {preview}
    </pre>
  );
}

interface QuestionTabsProps {
  disabled: boolean;
  currentIndex: number;
  formState: QuestionFormState;
  onSelect: (index: number) => void;
  questions: readonly Question[];
}

function QuestionTabs({
  disabled,
  currentIndex,
  formState,
  onSelect,
  questions,
}: QuestionTabsProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    const list = listRef.current;
    const active = activeRef.current;

    if (!list || !active) return;

    const strip = list.getBoundingClientRect();
    const tab = active.getBoundingClientRect();

    if (tab.left < strip.left) list.scrollLeft += tab.left - strip.left;

    if (tab.right > strip.right) list.scrollLeft += tab.right - strip.right;
  }, [currentIndex, formState]);

  const totals = new Map<string, number>();
  const occurrences = new Map<string, number>();

  for (const { shortLabel } of questions) {
    totals.set(shortLabel, (totals.get(shortLabel) ?? 0) + 1);
  }

  return (
    <div
      ref={listRef}
      className="mb-2 flex min-w-0 shrink-0 items-center gap-0.5 overflow-x-auto"
    >
      {questions.map((question, index) => {
        const state = answerStateFor(formState, question);

        const selected = question.options.filter((option) =>
          state.selected.includes(option.value),
        );

        const summary =
          selected.length > 1
            ? `${selected.length} selected`
            : (selected[0]?.label ?? state.otherText.trim());

        const answered = isQuestionAnswered(question, state);
        const occurrence = (occurrences.get(question.shortLabel) ?? 0) + 1;
        occurrences.set(question.shortLabel, occurrence);

        const label =
          totals.get(question.shortLabel) === 1
            ? question.shortLabel
            : `${question.shortLabel} ${occurrence}`;

        const isActive = index === currentIndex;

        return (
          <button
            key={question.id}
            ref={isActive ? activeRef : undefined}
            type="button"
            disabled={disabled}
            onClick={() => onSelect(index)}
            aria-pressed={isActive}
            aria-label={answered ? `${label} ${summary}` : undefined}
            className={cn(
              "flex h-7 shrink-0 items-center gap-1 rounded-md px-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
              isActive
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:bg-state-hover",
            )}
          >
            {answered ? (
              <Icon
                name="Check"
                className="size-3 shrink-0 text-success"
                aria-hidden
              />
            ) : null}
            <span className="max-w-40 truncate text-xs" title={question.prompt}>
              {label}
            </span>
            {answered ? (
              <span
                className="max-w-24 truncate text-xs text-subtle-foreground"
                title={summary}
              >
                {summary}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

function QuestionContext({ context }: { context: string }) {
  const id = useId();
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="mt-1 flex items-start gap-2 text-xs text-muted-foreground">
      <p
        id={id}
        className={cn(
          "min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere]",
          !expanded && "line-clamp-1",
        )}
      >
        {context}
      </p>
      <button
        type="button"
        aria-controls={id}
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
        className="shrink-0 rounded-sm underline decoration-dotted underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        {expanded ? "Less" : "More"}
      </button>
    </div>
  );
}

interface QuestionInputBlockProps {
  disabled: boolean;
  question: Question;
  state: QuestionAnswerState;
  onToggleOption: (optionValue: string, advance?: boolean) => void;
  onSelectOther: () => void;
  onFreeTextChange: (value: string) => void;
  onShortcutSubmit: () => void;
  onVoiceInputActiveChange: (active: boolean) => void;
  shortcuts: ReadonlyMap<string, QuestionShortcut>;
  renderRichPreview?: QuestionFormProps["renderRichPreview"];
  showOptional: boolean;
}

function QuestionInputBlock({
  disabled,
  question,
  state,
  onToggleOption,
  onSelectOther,
  onFreeTextChange,
  onShortcutSubmit,
  onVoiceInputActiveChange,
  shortcuts,
  renderRichPreview,
  showOptional,
}: QuestionInputBlockProps) {
  const freeTextRef = useRef<HTMLTextAreaElement>(null);
  const isPointerCoarse = usePointerCoarse();

  const resizeFreeTextArea = useAutoGrow(freeTextRef, {
    minHeight: FREE_TEXT_MIN_HEIGHT,
    maxHeight: FREE_TEXT_MAX_HEIGHT,
  });

  const options = question.options;

  const showOtherOption =
    question.allowFreeText && options.length > 0 && !question.additiveNotes;

  const checkedIndex =
    state.otherSelected && showOtherOption
      ? options.length
      : options.findIndex((option) => state.selected.includes(option.value));

  const freeTextLabel = `${question.shortLabel} answer`;

  useLayoutEffect(() => {
    if (!state.otherSelected) return;
    resizeFreeTextArea();
  }, [question.id, resizeFreeTextArea, state.otherSelected, state.otherText]);

  const handleFreeTextKeyDown = (
    event: KeyboardEvent<HTMLTextAreaElement>,
  ): void => {
    if (
      event.nativeEvent.isComposing ||
      event.key !== "Enter" ||
      (!event.metaKey && !event.ctrlKey)
    ) {
      return;
    }

    event.preventDefault();
    onShortcutSubmit();
  };

  const handleRadioNavigation = (event: KeyboardEvent<HTMLDivElement>) => {
    if (question.multiSelect) return;

    const delta = RADIO_ARROW_DIRECTION[event.key];

    if (!delta) return;

    const radios = [
      ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
        '[role="radio"]',
      ),
    ];

    const focusedIndex = radios.findIndex((radio) => radio === event.target);

    if (focusedIndex < 0) return;
    event.preventDefault();
    const nextIndex = (focusedIndex + delta + radios.length) % radios.length;
    radios[nextIndex]?.focus();
    const option = options[nextIndex];

    if (option) onToggleOption(option.value, false);
    else onSelectOther();
  };

  return (
    <fieldset disabled={disabled} className="min-w-0">
      <legend className="sr-only">{question.prompt}</legend>
      {question.prompt ? (
        <div className="text-sm leading-snug text-foreground [overflow-wrap:anywhere]">
          {question.prompt}
          {showOptional && question.optional ? (
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              Optional
            </span>
          ) : null}
        </div>
      ) : null}
      {question.context ? <QuestionContext context={question.context} /> : null}
      {options.length > 0 ? (
        <div
          role={question.multiSelect ? "group" : "radiogroup"}
          aria-label={question.prompt}
          onKeyDown={handleRadioNavigation}
          className="mt-2 space-y-0.5"
        >
          {options.map((option: QuestionOption, index) => {
            const checked = state.selected.includes(option.value);

            return (
              <div key={option.value}>
                <QuestionOptionRow
                  checked={checked}
                  label={option.label}
                  description={option.description}
                  recommended={option.recommended}
                  multiSelect={question.multiSelect}
                  onSelect={() => onToggleOption(option.value)}
                  shortcut={shortcuts.get(String(index))}
                  tabIndex={
                    question.multiSelect
                      ? undefined
                      : index === Math.max(0, checkedIndex)
                        ? 0
                        : -1
                  }
                />
                {checked && option.preview ? (
                  <QuestionOptionPreview
                    preview={option.preview}
                    renderRichPreview={renderRichPreview}
                  />
                ) : null}
              </div>
            );
          })}
          {showOtherOption ? (
            <QuestionOptionRow
              checked={state.otherSelected}
              label={OTHER_OPTION_LABEL}
              multiSelect={question.multiSelect}
              onSelect={onSelectOther}
              shortcut={shortcuts.get(String(options.length))}
              tabIndex={
                question.multiSelect
                  ? undefined
                  : checkedIndex === options.length
                    ? 0
                    : -1
              }
            />
          ) : null}
        </div>
      ) : null}
      {question.allowFreeText &&
      options.length > 0 &&
      question.additiveNotes ? (
        <button
          type="button"
          aria-pressed={state.otherSelected}
          aria-keyshortcuts={
            shortcuts.get(String(options.length))?.ariaKeyshortcuts
          }
          onClick={onSelectOther}
          className="mt-1 inline-flex items-baseline gap-2 rounded-md px-2.5 py-1 text-xs text-muted-foreground underline decoration-dotted underline-offset-2 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          {state.otherSelected
            ? "Remove note"
            : "Add a note or your own answer"}
          {shortcuts.get(String(options.length)) ? (
            <kbd
              aria-hidden="true"
              className="text-xs font-normal text-subtle-foreground no-underline"
            >
              {shortcuts.get(String(options.length))?.label}
            </kbd>
          ) : null}
        </button>
      ) : null}
      {state.otherSelected ? (
        <VoiceInputTextarea
          ref={freeTextRef}
          aria-label={freeTextLabel}
          value={state.otherText}
          rows={1}
          autoFocus={!isPointerCoarse}
          autoComplete="off"
          onValueChange={onFreeTextChange}
          onVoiceInputActiveChange={onVoiceInputActiveChange}
          onKeyDown={handleFreeTextKeyDown}
          placeholder="Type your own answer…"
          className="mt-2 block w-full resize-none overflow-y-auto rounded-md border border-border bg-surface-raised px-3 py-2 text-sm leading-relaxed text-foreground placeholder:text-muted-foreground focus-visible:border-ring/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/40"
          style={{
            minHeight: `${FREE_TEXT_MIN_HEIGHT}px`,
            maxHeight: `${FREE_TEXT_MAX_HEIGHT}px`,
          }}
        />
      ) : null}
    </fieldset>
  );
}

export interface QuestionFormProps {
  renderRichPreview?: (preview: string) => ReactNode;
  draftKey?: string;
  progressTarget?: HTMLElement | null;
  questions: readonly Question[];
  disabled: boolean;
  cancelDisabled: boolean;
  cancelLabel?: string;
  onSelectionChange?: () => void;
  onSubmit: (answers: Record<string, QuestionAnswer>) => void | Promise<void>;
  onCancel: () => void | Promise<void>;
}

export function QuestionForm({
  draftKey,
  progressTarget,
  renderRichPreview,
  questions,
  disabled: inputDisabled,
  cancelDisabled,
  cancelLabel = "Cancel",
  onSelectionChange,
  onSubmit,
  onCancel,
}: QuestionFormProps) {
  const { formState, setFormState, currentIndex, setCurrentIndex, clearDraft } =
    useQuestionFormDraft(draftKey, questions);

  const [settledAction, setSettledAction] = useState<
    "submit" | "cancel" | null
  >(null);

  const disabled = inputDisabled || settledAction !== null;
  const [voiceBusy, setVoiceBusy] = useState(false);
  const formRef = useRef<HTMLDivElement>(null);
  const advanceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { shortcuts, registerChoiceHandler } = useQuestionFormHost();

  const totalQuestions = questions.length;
  const currentQuestion = questions[currentIndex] ?? null;
  const isFirst = currentIndex === 0;
  const isLast = currentIndex === totalQuestions - 1;

  const answered = useMemo(
    () =>
      questions.map((question) =>
        isQuestionAnswered(question, answerStateFor(formState, question)),
      ),
    [formState, questions],
  );

  const answerCount = answered.filter(Boolean).length;

  const canSubmit = questions.every(
    (question, index) => question.optional || answered[index],
  );

  const showSubmit = isLast;

  const submitLabel =
    totalQuestions === 1
      ? "Submit answer"
      : `Submit ${answerCount} ${answerCount === 1 ? "answer" : "answers"}`;

  const cancelAdvance = useCallback(() => {
    if (advanceTimer.current === null) return;
    clearTimeout(advanceTimer.current);
    advanceTimer.current = null;
  }, []);

  useEffect(
    () => cancelAdvance,
    [cancelAdvance, currentQuestion?.id, disabled, voiceBusy],
  );

  const goToQuestion = useCallback(
    (index: number) => {
      cancelAdvance();

      if (index !== currentIndex) onSelectionChange?.();
      setCurrentIndex(index);
      formRef.current?.focus({ preventScroll: true });
    },
    [cancelAdvance, currentIndex, onSelectionChange, setCurrentIndex],
  );

  const updateQuestionState = useCallback(
    (
      question: Question,
      update: (state: QuestionAnswerState) => QuestionAnswerState,
    ): void => {
      setFormState((current) => ({
        ...current,
        [question.id]: update(answerStateFor(current, question)),
      }));
    },
    [setFormState],
  );

  const handleToggleOption = useCallback(
    (question: Question, optionValue: string, advance = true): void => {
      const state = answerStateFor(formState, question);

      if (!question.multiSelect && state.selected.includes(optionValue)) return;
      onSelectionChange?.();
      cancelAdvance();
      updateQuestionState(question, (state) => {
        if (question.multiSelect) {
          const selected = state.selected.includes(optionValue)
            ? state.selected.filter((value) => value !== optionValue)
            : [...state.selected, optionValue];

          return { ...state, selected };
        }

        return {
          ...state,
          selected: [optionValue],
          otherSelected: question.additiveNotes ? state.otherSelected : false,
        };
      });

      if (
        !advance ||
        question.multiSelect ||
        voiceBusy ||
        (question.additiveNotes &&
          answerStateFor(formState, question).otherSelected)
      )
        return;

      const next = answered.findIndex(
        (hasAnswer, index) => index > currentIndex && !hasAnswer,
      );

      const earlierRequired = questions.findIndex(
        (entry, index) =>
          index < currentIndex && !entry.optional && !answered[index],
      );

      const destination = next >= 0 ? next : earlierRequired;

      if (destination < 0) return;

      advanceTimer.current = setTimeout(() => {
        if (
          !formRef.current?.contains(document.activeElement) &&
          document.activeElement !== document.body
        )
          return;
        goToQuestion(destination);
      }, ADVANCE_DELAY_MS);
    },
    [
      answered,
      cancelAdvance,
      currentIndex,
      formState,
      goToQuestion,
      onSelectionChange,
      questions,
      updateQuestionState,
      voiceBusy,
    ],
  );

  const handleSelectOther = useCallback(
    (question: Question): void => {
      const toggle = question.multiSelect || question.additiveNotes;

      if (!toggle && answerStateFor(formState, question).otherSelected) return;
      onSelectionChange?.();
      cancelAdvance();
      updateQuestionState(question, (state) =>
        toggle
          ? { ...state, otherSelected: !state.otherSelected }
          : { ...state, selected: [], otherSelected: true },
      );
    },
    [cancelAdvance, formState, onSelectionChange, updateQuestionState],
  );

  const handleFreeTextChange = (question: Question, value: string): void => {
    updateQuestionState(question, (state) => ({ ...state, otherText: value }));
  };

  const submitAnswer = async (): Promise<void> => {
    if (disabled || voiceBusy || !canSubmit || answerCount === 0) return;

    try {
      await onSubmit(buildQuestionAnswers(questions, formState));
      setSettledAction("submit");
      clearDraft();
    } catch {}
  };

  const handleAdvance = (): void => {
    if (disabled || voiceBusy) return;
    cancelAdvance();

    if (showSubmit) {
      void submitAnswer();

      return;
    }

    goToQuestion(currentIndex + 1);
  };

  useEffect(() => {
    if (disabled || voiceBusy || currentQuestion === null) return;

    return registerChoiceHandler((index) => {
      const choice = resolveQuestionShortcutChoice(currentQuestion, index);

      if (!choice) return false;

      if (choice.kind === "option") {
        handleToggleOption(currentQuestion, choice.value);
        formRef.current?.focus({ preventScroll: true });
      } else handleSelectOther(currentQuestion);

      return true;
    });
  }, [
    disabled,
    voiceBusy,
    currentQuestion,
    registerChoiceHandler,
    handleToggleOption,
    handleSelectOther,
  ]);

  if (!currentQuestion) return null;

  const currentState = answerStateFor(formState, currentQuestion);

  const progress = (
    <span className="shrink-0 whitespace-nowrap text-xs tabular-nums text-muted-foreground">
      {currentIndex + 1} of {totalQuestions}
    </span>
  );

  return (
    <div
      ref={formRef}
      tabIndex={-1}
      aria-label={currentQuestion.prompt}
      onKeyDown={(event) => {
        if (
          (event.target !== event.currentTarget &&
            !(
              showSubmit &&
              event.target instanceof HTMLElement &&
              event.target.matches(
                '[data-question-option][aria-checked="true"]',
              )
            )) ||
          event.defaultPrevented ||
          event.nativeEvent.isComposing ||
          event.key !== "Enter" ||
          event.shiftKey ||
          event.metaKey ||
          event.ctrlKey ||
          event.altKey ||
          disabled
        )
          return;
        event.preventDefault();
        handleAdvance();
      }}
      data-question-form=""
      className="-m-1 flex min-h-0 flex-col rounded-md p-1 text-xs text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
    >
      {progressTarget ? (
        createPortal(progress, progressTarget)
      ) : totalQuestions > 1 ? (
        <div className="mb-1 self-end">{progress}</div>
      ) : null}
      {totalQuestions > 1 ? (
        <QuestionTabs
          disabled={disabled || voiceBusy}
          currentIndex={currentIndex}
          formState={formState}
          onSelect={goToQuestion}
          questions={questions}
        />
      ) : null}
      <div>
        <QuestionInputBlock
          key={currentQuestion.id}
          disabled={disabled}
          question={currentQuestion}
          state={currentState}
          onToggleOption={(optionValue, advance) =>
            handleToggleOption(currentQuestion, optionValue, advance)
          }
          onSelectOther={() => handleSelectOther(currentQuestion)}
          onFreeTextChange={(value) =>
            handleFreeTextChange(currentQuestion, value)
          }
          onVoiceInputActiveChange={setVoiceBusy}
          onShortcutSubmit={handleAdvance}
          shortcuts={shortcuts}
          renderRichPreview={renderRichPreview}
          showOptional={progressTarget === undefined}
        />
      </div>
      <div
        data-question-form-actions=""
        className="mt-3 flex shrink-0 items-center justify-between gap-2"
      >
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={cancelDisabled || settledAction !== null}
          onClick={async () => {
            cancelAdvance();

            try {
              await onCancel();
              setSettledAction("cancel");
              clearDraft();
            } catch {}
          }}
        >
          {cancelLabel}
        </Button>
        <div className="flex items-center gap-2">
          {!isFirst ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={disabled || voiceBusy}
              onClick={() => goToQuestion(currentIndex - 1)}
            >
              Back
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            disabled={
              disabled ||
              voiceBusy ||
              (showSubmit && (!canSubmit || answerCount === 0))
            }
            onClick={handleAdvance}
          >
            {inputDisabled || settledAction === "submit" ? (
              <Icon name="Spinner" className="size-3 animate-spin" />
            ) : null}
            {showSubmit ? submitLabel : "Next"}
          </Button>
        </div>
      </div>
    </div>
  );
}
