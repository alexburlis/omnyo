import type { InboxActRequest, InboxEntry, InboxSnapshot } from "@omnyo/domain";

export type InboxPredict = (snapshot: InboxSnapshot) => InboxSnapshot;

type InboxList = "inbox" | "waiting" | "running" | "shelf";

const INBOX_LISTS: readonly InboxList[] = [
  "inbox",
  "waiting",
  "running",
  "shelf",
];

const ALL_LISTS: ReadonlySet<InboxList> = new Set(INBOX_LISTS);

const WORK_LISTS: ReadonlySet<InboxList> = new Set([
  "inbox",
  "waiting",
  "running",
]);

const CARD_ONLY: ReadonlySet<InboxList> = new Set(["inbox"]);

const CARD_AND_WAIT: ReadonlySet<InboxList> = new Set(["inbox", "waiting"]);

const WORK_REPORT_CAUSES: ReadonlySet<string> = new Set([
  "result",
  "problem",
  "question",
]);

const RESTS_WHEN_SHELVED: ReadonlySet<string> = new Set([
  "archive",
  "your-call",
]);

type Order = (a: InboxEntry, b: InboxEntry) => number;

const byThread: Order = (a, b) =>
  a.threadId < b.threadId ? -1 : a.threadId > b.threadId ? 1 : 0;

const bySortAt: Order = (a, b) => a.sortAt - b.sortAt;

const LIST_ORDER: Readonly<Record<InboxList, Order>> = {
  inbox: (a, b) =>
    Number(a.card?.kind !== "question") - Number(b.card?.kind !== "question") ||
    bySortAt(a, b) ||
    byThread(a, b),
  waiting: (a, b) =>
    Number(a.waiting?.group !== "on-you") -
      Number(b.waiting?.group !== "on-you") ||
    (a.waiting?.returnAt ?? Number.MAX_SAFE_INTEGER) -
      (b.waiting?.returnAt ?? Number.MAX_SAFE_INTEGER) ||
    byThread(a, b),
  running: bySortAt,
  shelf: bySortAt,
};

function earliest(values: readonly (number | null)[]): number | null {
  let result: number | null = null;

  for (const value of values)
    if (value !== null && (result === null || value < result)) result = value;

  return result;
}

export function recountInbox(snapshot: InboxSnapshot): InboxSnapshot {
  const { inbox, waiting, running } = snapshot;

  return {
    ...snapshot,
    counts: {
      needsYou: inbox.filter((entry) => entry.state === "needs-you").length,
      inbox: inbox.length,
      questions: inbox.filter((entry) => entry.card?.kind === "question")
        .length,
      running: running.length,
      waiting: waiting.length,
      onYou: waiting.flatMap((entry) =>
        entry.waiting?.group === "on-you"
          ? [entry.waiting.reason ?? entry.title]
          : [],
      ),
      nextBackAt: earliest(
        waiting.map((entry) =>
          entry.waiting?.guaranteed ? entry.waiting.returnAt : null,
        ),
      ),
    },
  };
}

function mapLists(
  snapshot: InboxSnapshot,
  lists: ReadonlySet<InboxList>,
  change: (entries: InboxEntry[], list: InboxList) => InboxEntry[],
): InboxSnapshot {
  const next = { ...snapshot };

  for (const list of INBOX_LISTS)
    if (lists.has(list)) next[list] = change(snapshot[list], list);

  return next;
}

function withoutThreads(
  snapshot: InboxSnapshot,
  threadIds: ReadonlySet<string>,
  lists: ReadonlySet<InboxList>,
): InboxSnapshot {
  return mapLists(snapshot, lists, (entries) =>
    entries.filter((entry) => !threadIds.has(entry.threadId)),
  );
}

function withoutMembers(
  snapshot: InboxSnapshot,
  threadIds: ReadonlySet<string>,
): InboxSnapshot {
  const prune = (entry: InboxEntry): InboxEntry => {
    const runs = entry.runs?.filter((run) => !threadIds.has(run.threadId));

    const members = entry.incident?.members.filter(
      (member) => !threadIds.has(member.threadId),
    );

    if (
      runs?.length === entry.runs?.length &&
      members?.length === entry.incident?.members.length
    )
      return entry;

    return {
      ...entry,
      runs: runs ?? null,
      incident:
        entry.incident === null || members === undefined
          ? entry.incident
          : { ...entry.incident, members },
    };
  };

  return mapLists(snapshot, ALL_LISTS, (entries) => entries.map(prune));
}

function findEntry(
  snapshot: InboxSnapshot,
  threadId: string,
): InboxEntry | undefined {
  for (const list of INBOX_LISTS) {
    const found = snapshot[list].find((entry) => entry.threadId === threadId);

    if (found) return found;
  }

  return undefined;
}

function inserted(
  entries: readonly InboxEntry[],
  entry: InboxEntry,
  list: InboxList,
): InboxEntry[] {
  const rest = entries.filter((item) => item.threadId !== entry.threadId);
  const at = rest.findIndex((item) => LIST_ORDER[list](entry, item) < 0);

  return at < 0
    ? [...rest, entry]
    : [...rest.slice(0, at), entry, ...rest.slice(at)];
}

function belongsTo(entry: InboxEntry, list: InboxList): boolean {
  return list === "shelf" ? entry.shelved : entry.view === list;
}

function groupedMember(snapshot: InboxSnapshot, threadId: string): boolean {
  return snapshot.inbox.some(
    (item) =>
      item.threadId !== threadId &&
      [...(item.runs ?? []), ...(item.incident?.members ?? [])].some(
        (member) => member.threadId === threadId,
      ),
  );
}

function placed(snapshot: InboxSnapshot, entry: InboxEntry): InboxSnapshot {
  return mapLists(snapshot, ALL_LISTS, (entries, list) =>
    belongsTo(entry, list)
      ? inserted(entries, entry, list)
      : entries.filter((item) => item.threadId !== entry.threadId),
  );
}

export function withInboxEntry(
  snapshot: InboxSnapshot,
  threadId: string,
  entry: InboxEntry | null,
): InboxSnapshot {
  if (groupedMember(snapshot, threadId)) return snapshot;

  if (entry === null)
    return recountInbox(
      withoutThreads(snapshot, new Set([threadId]), ALL_LISTS),
    );

  return recountInbox(placed(snapshot, entry));
}

export function removeInboxThreads(
  snapshot: InboxSnapshot,
  threadIds: Iterable<string>,
): InboxSnapshot {
  const ids = new Set(threadIds);

  return recountInbox(
    withoutMembers(withoutThreads(snapshot, ids, ALL_LISTS), ids),
  );
}

function archivedEntry(entry: InboxEntry): InboxEntry {
  return {
    ...entry,
    state: "archive",
    reason: { kind: "none", text: "", threadId: entry.threadId },
    archiveReady: false,
    optionalQuestion: null,
    view: "archive",
    card: null,
    waiting: null,
    running: null,
    runs: null,
    incident: null,
    latch: "archive",
  };
}

export function archiveInboxThreads(
  snapshot: InboxSnapshot,
  threadIds: Iterable<string>,
): InboxSnapshot {
  const ids = new Set(threadIds);

  const removed = withoutMembers(
    withoutThreads(snapshot, ids, WORK_LISTS),
    ids,
  );

  return recountInbox({
    ...removed,
    shelf: removed.shelf.map((entry) =>
      ids.has(entry.threadId) ? archivedEntry(entry) : entry,
    ),
  });
}

function resultCard(entry: InboxEntry): InboxEntry["card"] {
  const card = entry.card;

  return card === null || card.kind === "question" || card.kind === "problem"
    ? null
    : card;
}

function shelvedEntry(entry: InboxEntry): InboxEntry {
  const card = resultCard(entry);
  const shelved = { ...entry, shelved: true, archiveReady: false };

  return card === null || !RESTS_WHEN_SHELVED.has(card.primary.kind)
    ? shelved
    : {
        ...shelved,
        card: { ...card, primary: { kind: "ok", thenWaits: null } },
      };
}

function restingOnShelf(entry: InboxEntry): boolean {
  const primary = resultCard(entry)?.primary;

  return entry.shelved && primary?.kind === "ok" && primary.thenWaits === null;
}

export function shelveInboxThread(
  snapshot: InboxSnapshot,
  threadId: string,
  shelved: boolean,
): InboxSnapshot {
  const source = findEntry(snapshot, threadId);

  if (source === undefined) return snapshot;

  if (shelved) {
    const entry = shelvedEntry(source);

    const marked = mapLists(snapshot, WORK_LISTS, (entries) =>
      entries.map((item) => (item.threadId === threadId ? entry : item)),
    );

    return recountInbox({
      ...marked,
      shelf: inserted(snapshot.shelf, entry, "shelf"),
    });
  }

  const inWork =
    source.view === "inbox" ||
    source.view === "waiting" ||
    source.view === "running";

  if (!inWork || restingOnShelf(source)) return snapshot;

  const marked = mapLists(snapshot, WORK_LISTS, (entries) =>
    entries.map((item) =>
      item.threadId === threadId ? { ...item, shelved: false } : item,
    ),
  );

  return recountInbox({
    ...marked,
    shelf: snapshot.shelf.filter((entry) => entry.threadId !== threadId),
  });
}

export function retitleInboxThread(
  snapshot: InboxSnapshot,
  threadId: string,
  title: string,
): InboxSnapshot {
  const rename = <T extends { threadId: string; title: string }>(item: T): T =>
    item.threadId === threadId && item.title !== title
      ? { ...item, title }
      : item;

  return mapLists(snapshot, ALL_LISTS, (entries) =>
    entries.map((entry) => {
      const renamed = rename(entry);
      const runs = renamed.runs?.map(rename) ?? null;

      const incident =
        renamed.incident === null
          ? null
          : {
              ...renamed.incident,
              members: renamed.incident.members.map(rename),
            };

      return { ...renamed, runs, incident };
    }),
  );
}

function canStartTurn(entry: InboxEntry, clearsFailure: boolean): boolean {
  if (entry.runs !== null || entry.incident !== null) return false;

  if (entry.view === "waiting")
    return (
      entry.waiting !== null &&
      !entry.waiting.checking &&
      entry.waiting.questionId === null &&
      entry.waiting.retry === null
    );

  const card = entry.card;

  if (card === null) return true;

  if (card.kind === "question" || card.snoozedQuestionUntil !== null)
    return false;

  if (card.kind === "problem" || card.failure !== null) return clearsFailure;

  return card.causes.every((cause) => WORK_REPORT_CAUSES.has(cause.cause));
}

function runningEntry(entry: InboxEntry, label: string): InboxEntry {
  return {
    ...entry,
    state: "working",
    reason: { kind: "activity", text: label, threadId: entry.threadId },
    archiveReady: false,
    optionalQuestion: null,
    view: "running",
    card: null,
    waiting: null,
    running: { label, progress: null },
    latch: "running",
  };
}

export function startInboxTurn(
  snapshot: InboxSnapshot,
  threadId: string,
  options: { label?: string; clearsFailure?: boolean } = {},
): InboxSnapshot {
  const label = options.label ?? "Working";

  const source =
    findEntry(snapshot, threadId) ??
    snapshot.inbox.find((entry) => entry.card?.failure?.threadId === threadId);

  if (source === undefined || source.view === "running") return snapshot;

  if (!canStartTurn(source, options.clearsFailure ?? false)) return snapshot;

  if (source.view !== "inbox" && source.view !== "waiting") return snapshot;

  return recountInbox(placed(snapshot, runningEntry(source, label)));
}

export function stopInboxTurn(
  snapshot: InboxSnapshot,
  threadId: string,
): InboxSnapshot {
  const source = snapshot.running.find((entry) => entry.threadId === threadId);

  if (source === undefined || source.running === null) return snapshot;

  return placed(snapshot, {
    ...source,
    reason: { ...source.reason, text: "Stopping" },
    running: { ...source.running, label: "Stopping" },
  });
}

export function scheduleInboxSend(
  snapshot: InboxSnapshot,
  threadId: string,
  sendAt: number,
): InboxSnapshot {
  const source = findEntry(snapshot, threadId);

  if (source === undefined || source.runs !== null || source.incident !== null)
    return snapshot;

  if (source.view === "waiting" && source.waiting !== null) {
    const returnAt = earliest([source.waiting.returnAt, sendAt]);

    return recountInbox(
      placed(snapshot, {
        ...source,
        waiting: { ...source.waiting, returnAt, guaranteed: true },
      }),
    );
  }

  const card = source.card;

  if (
    source.view !== "inbox" ||
    card === null ||
    card.kind !== "result" ||
    card.causes.length > 0
  )
    return snapshot;

  return recountInbox(
    placed(snapshot, waitingEntry(source, sendAt, "Your message sends")),
  );
}

function waitingEntry(
  entry: InboxEntry,
  until: number,
  reason = "Waiting",
): InboxEntry {
  return {
    ...entry,
    state: "waiting",
    reason: { kind: "wait", text: reason, threadId: entry.threadId },
    archiveReady: false,
    view: "waiting",
    card: null,
    running: null,
    waiting: {
      group: "comes-back",
      reason,
      waitId: null,
      returnAt: until,
      checkAt: null,
      checkCount: 0,
      checking: false,
      guaranteed: true,
      behind: null,
      retry: null,
      questionId: null,
    },
    latch: "waiting",
  };
}

function waitInboxThread(
  snapshot: InboxSnapshot,
  threadId: string,
  until: number,
): InboxSnapshot {
  const source = snapshot.inbox.find((entry) => entry.threadId === threadId);

  if (
    source === undefined ||
    source.runs !== null ||
    source.incident !== null ||
    source.card?.kind === "question"
  )
    return recountInbox(
      withoutThreads(snapshot, new Set([threadId]), CARD_ONLY),
    );

  return recountInbox(placed(snapshot, waitingEntry(source, until)));
}

export function inboxActThreadIds(request: InboxActRequest): string[] {
  return request.action === "archive-runs"
    ? [...new Set([request.threadId, ...request.threadIds])]
    : [request.threadId];
}

export function predictInboxAct(
  snapshot: InboxSnapshot,
  request: InboxActRequest,
): InboxSnapshot {
  switch (request.action) {
    case "archive":
      return archiveInboxThreads(snapshot, [request.threadId]);
    case "archive-runs": {
      const archived = archiveInboxThreads(snapshot, request.threadIds);

      return recountInbox({
        ...archived,
        inbox: archived.inbox.map((entry) =>
          entry.threadId === request.threadId && entry.runs !== null
            ? {
                ...entry,
                runs: entry.runs.filter(
                  (run) => !request.threadIds.includes(run.threadId),
                ),
              }
            : entry,
        ),
      });
    }

    case "shelf":
      return shelveInboxThread(snapshot, request.threadId, request.shelved);
    case "wait":
      return waitInboxThread(snapshot, request.threadId, request.until);
    case "happened":
    case "cancel-wait":
      return recountInbox(
        withoutThreads(snapshot, new Set([request.threadId]), CARD_AND_WAIT),
      );
    case "resume":
    case "continue-with-result":
    case "resume-all-at-reset":
      return startInboxTurn(snapshot, request.threadId, {
        clearsFailure: true,
      });
    case "ok":
    case "wait-report":
    case "accept-proposal":
    case "keep-waiting":
    case "remind-later":
    case "snooze-question":
      return recountInbox(
        withoutThreads(snapshot, new Set([request.threadId]), CARD_ONLY),
      );
  }
}

export interface InboxRows {
  threadIds: readonly string[];
  rows: ReadonlyMap<InboxList, readonly { index: number; entry: InboxEntry }[]>;
}

export function captureInboxRows(
  snapshot: InboxSnapshot,
  threadIds: readonly string[],
): InboxRows {
  const wanted = new Set(threadIds);

  return {
    threadIds,
    rows: new Map(
      INBOX_LISTS.map((list) => [
        list,
        snapshot[list].flatMap((entry, index) =>
          wanted.has(entry.threadId) ? [{ index, entry }] : [],
        ),
      ]),
    ),
  };
}

export function restoreInboxRows(
  snapshot: InboxSnapshot,
  saved: InboxRows,
): InboxSnapshot {
  const ids = new Set(saved.threadIds);

  return recountInbox(
    mapLists(snapshot, ALL_LISTS, (entries, list) => {
      const next = entries.filter((entry) => !ids.has(entry.threadId));

      for (const { index, entry } of saved.rows.get(list) ?? [])
        next.splice(Math.min(index, next.length), 0, entry);

      return next;
    }),
  );
}

export function hasInboxRows(saved: InboxRows): boolean {
  for (const rows of saved.rows.values()) if (rows.length > 0) return true;

  return false;
}

export function answerInboxQuestions(
  snapshot: InboxSnapshot,
  threadId: string,
  questionIds: readonly string[],
  resumes: boolean,
): InboxSnapshot {
  const answered = new Set(questionIds);

  const entry =
    snapshot.inbox.find(
      (item) =>
        item.card?.kind === "question" &&
        item.card.questionIds.some((id) => answered.has(id)),
    ) ?? snapshot.inbox.find((item) => item.threadId === threadId);

  const card = entry?.card ?? null;

  if (
    entry === undefined ||
    card === null ||
    card.kind !== "question" ||
    entry.runs !== null ||
    entry.incident !== null
  )
    return snapshot;

  const remaining = card.questionIds.filter((id) => !answered.has(id));

  if (remaining.length === card.questionIds.length) return snapshot;

  if (remaining.length > 0)
    return {
      ...snapshot,
      inbox: snapshot.inbox.map((item) =>
        item === entry
          ? { ...entry, card: { ...card, questionIds: remaining } }
          : item,
      ),
    };

  const withoutCard = recountInbox({
    ...snapshot,
    inbox: snapshot.inbox.filter((item) => item !== entry),
  });

  if (!resumes && entry.running === null) return withoutCard;

  const uncarded = {
    ...snapshot,
    inbox: snapshot.inbox.map((item) =>
      item === entry ? { ...entry, card: null } : item,
    ),
  };

  const started = startInboxTurn(uncarded, entry.threadId);

  return started === uncarded ? withoutCard : started;
}
