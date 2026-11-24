import { StoryCard, StoryRow } from "../../../.ladle/story-card";
import { AppToastContent } from "@/components/ui/app-toast";
import {
  DESKTOP_RELAUNCH_FAILED_TITLE,
  DESKTOP_UPDATE_READY_TITLE,
  desktopUpdatePromptOptions,
} from "./DesktopUpdatePromptHost";

export default {
  title: "app-update/Desktop update prompt",
};

const ready = desktopUpdatePromptOptions("0.46.20", {
  onLater: () => {},
  onRelaunch: () => {},
});

export function States() {
  return (
    <StoryCard labelWidth="190px" className="max-w-3xl">
      <StoryRow
        label="update downloaded"
        hint="Relaunch installs now; Later leaves it to the idle background install"
      >
        <AppToastContent
          action={ready.action}
          cancel={ready.cancel}
          description={ready.description}
          title={DESKTOP_UPDATE_READY_TITLE}
          tone="message"
        />
      </StoryRow>
      <StoryRow
        label="relaunch refused"
        hint="the desktop app's reason replaces a silent failure"
      >
        <AppToastContent
          description="Private update admission is already held"
          title={DESKTOP_RELAUNCH_FAILED_TITLE}
          tone="error"
        />
      </StoryRow>
    </StoryCard>
  );
}
