import { useId, useState, type FormEvent } from "react";
import { atom, useAtom } from "jotai";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { getErrorMessage } from "@omnyo/domain";
import {
  BUG_REPORT_MESSAGE_MAX_CHARS,
  bugReportRequestSchema,
  type BugReportRequest,
  type BugReportUnavailableReason,
  type SystemConfigResponse,
} from "@omnyo/server-contract";
import { Button } from "@omnyo/shared-ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@omnyo/shared-ui/dialog";
import { Input } from "@omnyo/shared-ui/input";
import { Label } from "@omnyo/shared-ui/label";
import { Textarea } from "@omnyo/shared-ui/textarea";
import { useSystemConfig } from "@/hooks/queries/system-queries";
import { sdk } from "@/lib/sdk";
import { readLastDeliveredWebErrorEventId } from "@/lib/web-error-reporting";

export const bugReportDialogOpenAtom = atom(false);

export function resolveBugReportUnavailableReason(
  config:
    | Pick<SystemConfigResponse, "diagnostics" | "generalSettings">
    | undefined,
): BugReportUnavailableReason | null {
  if (config === undefined) return null;

  if (!config.diagnostics?.sentryDsn) return "not-configured";

  if (!config.generalSettings.crashReportsEnabled) return "crash-reports-off";

  return null;
}

export function BugReportDialogHost() {
  const [open, setOpen] = useAtom(bugReportDialogOpenAtom);

  return <BugReportDialog open={open} onOpenChange={setOpen} />;
}

export function BugReportDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {open ? (
          <BugReportDialogContent onClose={() => onOpenChange(false)} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function BugReportDialogContent({ onClose }: { onClose: () => void }) {
  const { data: config } = useSystemConfig();
  const navigate = useNavigate();
  const messageId = useId();
  const emailId = useId();
  const [message, setMessage] = useState("");
  const [email, setEmail] = useState("");

  const [validationMessage, setValidationMessage] = useState<string | null>(
    null,
  );

  const report = useMutation({
    mutationFn: (request: BugReportRequest) =>
      sdk.system.experimental_reportBug(request),
  });

  const unavailableReason =
    report.data?.status === "unavailable"
      ? report.data.reason
      : resolveBugReportUnavailableReason(config);

  if (unavailableReason !== null) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>Report a bug</DialogTitle>
          <DialogDescription>
            {unavailableReason === "crash-reports-off"
              ? "Bug reports are off because Crash reports is off in Settings."
              : "This Omnyo server isn't set up to send bug reports."}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Close
          </Button>
          {unavailableReason === "crash-reports-off" ? (
            <Button
              size="sm"
              onClick={() => {
                onClose();
                void navigate("/settings");
              }}
            >
              Open Settings
            </Button>
          ) : null}
        </DialogFooter>
      </>
    );
  }

  if (report.data?.status === "sent") {
    return (
      <>
        <DialogHeader>
          <DialogTitle>Report sent</DialogTitle>
          <DialogDescription>
            Thanks. Your reference is{" "}
            <span className="select-text font-mono">
              {report.data.reportId}
            </span>
            .
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button size="sm" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </>
    );
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (report.isPending) return;
    const associatedEventId = readLastDeliveredWebErrorEventId();
    const trimmedEmail = email.trim();

    const parsed = bugReportRequestSchema.safeParse({
      message,
      ...(trimmedEmail === "" ? {} : { email: trimmedEmail }),
      ...(associatedEventId === null ? {} : { associatedEventId }),
    });

    if (!parsed.success) {
      setValidationMessage(
        parsed.error.issues[0]?.path[0] === "email"
          ? "Enter a valid email address, or leave it empty."
          : "Describe what went wrong.",
      );

      return;
    }

    setValidationMessage(null);
    report.mutate(parsed.data);
  };

  const errorMessage =
    validationMessage ??
    (report.error === null
      ? null
      : `Couldn't send the report. ${getErrorMessage(report.error)}`);

  return (
    <>
      <DialogHeader>
        <DialogTitle>Report a bug</DialogTitle>
        <DialogDescription>
          Omnyo sends this note, your email if you add one, its version and a
          link to its last error report. No chats, logs or screenshots.
        </DialogDescription>
      </DialogHeader>
      <form className="space-y-4" onSubmit={handleSubmit} noValidate>
        <div className="space-y-2">
          <Label htmlFor={messageId}>What went wrong?</Label>
          <Textarea
            id={messageId}
            className="min-h-32"
            placeholder="What you did, what you expected and what happened"
            maxLength={BUG_REPORT_MESSAGE_MAX_CHARS}
            value={message}
            disabled={report.isPending}
            onChange={(event) => setMessage(event.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={emailId}>Email for follow-up (optional)</Label>
          <Input
            id={emailId}
            type="email"
            autoComplete="email"
            value={email}
            disabled={report.isPending}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        {errorMessage === null ? null : (
          <p role="alert" className="text-sm text-destructive-text">
            {errorMessage}
          </p>
        )}
        <DialogFooter>
          <Button size="sm" variant="ghost" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            type="submit"
            disabled={report.isPending || message.trim() === ""}
          >
            {report.isPending ? "Sending…" : "Send report"}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}
