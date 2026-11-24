import { useState } from "react";
import { FileDropZone, type ChosenFile } from "@omnyo/shared-ui/file-drop-zone";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";

export default {
  title: "ui/File Drop Zone",
};

function DropZoneDemo({
  initial,
  busy = false,
}: {
  initial: ChosenFile | null;
  busy?: boolean;
}) {
  const [file, setFile] = useState<ChosenFile | null>(initial);
  const [message, setMessage] = useState("");

  return (
    <div className="flex w-full max-w-md flex-col gap-2">
      <FileDropZone
        accept=".omnyoworkflow"
        maxBytes={256 * 1024}
        file={file}
        busy={busy}
        title="Drop a workflow file here"
        hint=".omnyoworkflow, up to 256 KB"
        onFileSelect={(next) => {
          setMessage("");
          setFile({ name: next.name, size: next.size });
        }}
        onFileReject={setMessage}
        onClear={() => setFile(null)}
      />
      {message === "" ? null : (
        <p role="alert" className="text-xs text-destructive-text">
          {message}
        </p>
      )}
    </div>
  );
}

export function Overview() {
  return (
    <StoryCard>
      <StoryRow label="empty" hint="click or drop a file; keyboard focusable">
        <DropZoneDemo initial={null} />
      </StoryRow>
      <StoryRow label="chosen" hint="file name, size and a labelled remove">
        <DropZoneDemo
          initial={{ name: "weekly-content-feed.omnyoworkflow", size: 18_420 }}
        />
      </StoryRow>
      <StoryRow label="checking" hint="busy while the file is inspected">
        <DropZoneDemo
          initial={{ name: "release-review.omnyoworkflow", size: 7_310 }}
          busy
        />
      </StoryRow>
    </StoryCard>
  );
}
