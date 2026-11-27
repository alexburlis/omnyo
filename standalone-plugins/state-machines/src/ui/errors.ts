import { type SmError, TRANSPORT_ERROR } from "./data/client.js";

export interface ErrorCopy {
  title: string;
  body: string | null;
}

export function errorCopy(error: SmError, subject = "item"): ErrorCopy {
  switch (error.code) {
    case TRANSPORT_ERROR:
      return { title: "The State machines service isn't responding.", body: null };
    case "DRAFT_NOT_SAVED":
      return {
        title: "Save the draft before publishing.",
        body: "Check the save status above, then try again.",
      };
    case "NOT_FOUND":
      return { title: `This ${subject} doesn't exist.`, body: null };
    case "REVISION_CONFLICT":
      return { title: "The instance changed. Check its state and try again.", body: null };
    case "STALE_ENTRY":
      return {
        title: "This decision is for an earlier visit. The card has been refreshed.",
        body: null,
      };
    case "VALIDATION_FAILED":
      return { title: "Fix these before continuing.", body: error.message };
    case "UNSUPPORTED_SCHEMA":
      return { title: "This version uses a newer format than this plugin can show.", body: null };
    case "SCOPE_MISMATCH":
      return { title: "This item belongs to a different project.", body: null };
    case "EVENT_ID_CONFLICT":
      return { title: "That request was already sent with different details.", body: null };
    case "ENVIRONMENT_LIFETIME_UNSUPPORTED":
      return {
        title: "This environment may be retired, so it can't host a long-running instance.",
        body: error.message,
      };
    case "CAPABILITY_UNAVAILABLE":
      return { title: "Needs configuration.", body: error.message };
    case "AUTHORITY_REQUIRED":
      return {
        title:
          "Approval for external changes needs a verified person check that Omnyo doesn't have yet.",
        body: null,
      };
    case "INVOCATION_UNCERTAIN":
      return { title: "Outcome unknown.", body: error.message };
    case "BACKPRESSURE":
      return {
        title: "Too many pending inputs. Try again after the instance catches up.",
        body: null,
      };
    case "STOP_PENDING":
      return { title: "Still stopping: some steps haven't ended.", body: error.message };
    case "OUTPUT_LIMIT":
      return { title: "Output reached 1 MiB; the step was stopped.", body: null };
    case "STALE_SUBSCRIPTION":
    case "EXPIRED_RECEIPT":
      return { title: "This request expired. Press again to send a new one.", body: null };
    case "NON_YIELDING_CYCLE":
      return {
        title:
          "This loop ran 32 instant steps without waiting and was held. Edit the draft so the loop waits.",
        body: null,
      };
    default:
      return {
        title: "Something went wrong.",
        body: error.message.length > 0 ? error.message : null,
      };
  }
}
