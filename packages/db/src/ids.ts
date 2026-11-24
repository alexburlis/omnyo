import { customAlphabet } from "nanoid";
import { GENERATED_ID_ALPHABET, GENERATED_ID_SUFFIX_LENGTH } from "@omnyo/domain";

const generatePrettyIdSuffix = customAlphabet(
  GENERATED_ID_ALPHABET,
  GENERATED_ID_SUFFIX_LENGTH,
);

function createId(prefix: string): string {
  return `${prefix}_${generatePrettyIdSuffix()}`;
}

export function createHostId(): string {
  return createId("host");
}

export function createProjectId(): string {
  return createId("proj");
}

export function createProjectSourceId(): string {
  return createId("src");
}

export function createEnvironmentId(): string {
  return createId("env");
}

export function createThreadId(): string {
  return createId("thr");
}

export function createThreadSectionId(): string {
  return createId("sec");
}

export function createThreadGroupId(): string {
  return createId("grp");
}

export function createThreadProvisioningId(): string {
  return createId("tpv");
}

const EVENT_ID_TIME_DIGITS = 9;

const EVENT_ID_SEQUENCE_DIGITS = 3;

const EVENT_ID_RANDOM_DIGITS = 3;

const EVENT_ID_SEQUENCE_LIMIT =
  GENERATED_ID_ALPHABET.length ** EVENT_ID_SEQUENCE_DIGITS;

const generateEventIdRandomSuffix = customAlphabet(
  GENERATED_ID_ALPHABET,
  EVENT_ID_RANDOM_DIGITS,
);

let lastEventIdTime = 0;

let lastEventIdSequence = 0;

function encodeEventIdDigits(value: number, digits: number): string {
  let encoded = "";
  let remaining = value;

  for (let digit = 0; digit < digits; digit += 1) {
    encoded =
      GENERATED_ID_ALPHABET[remaining % GENERATED_ID_ALPHABET.length] + encoded;
    remaining = Math.floor(remaining / GENERATED_ID_ALPHABET.length);
  }

  return encoded;
}

export function createEventId(): string {
  const now = Date.now();

  if (now > lastEventIdTime) {
    lastEventIdTime = now;
    lastEventIdSequence = 0;
  } else if (lastEventIdSequence + 1 < EVENT_ID_SEQUENCE_LIMIT) {
    lastEventIdSequence += 1;
  } else {
    lastEventIdTime += 1;
    lastEventIdSequence = 0;
  }

  return `evt_${encodeEventIdDigits(lastEventIdTime, EVENT_ID_TIME_DIGITS)}${encodeEventIdDigits(lastEventIdSequence, EVENT_ID_SEQUENCE_DIGITS)}${generateEventIdRandomSuffix()}`;
}

export function createPromptHistoryEntryId(): string {
  return createId("phist");
}

export function createQueuedThreadMessageId(): string {
  return createId("qmsg");
}

export function createQueuedThreadMessageClaimToken(): string {
  return createId("qclaim");
}

export function createPendingInteractionId(): string {
  return createId("pint");
}

export function createHostDaemonSessionId(): string {
  return createId("hses");
}

export function createTerminalSessionId(): string {
  return createId("term");
}
