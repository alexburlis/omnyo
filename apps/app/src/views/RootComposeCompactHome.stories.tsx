import { StoryCard, StoryRow } from "../../.ladle/story-card";
import { CompactHomePage, PhoneFrame } from "./mobile-home-story-fixtures";

const LONG_DRAFT = Array.from(
  { length: 30 },
  (_, index) => `${index + 1}. Step ${index + 1} of the repro`,
).join("\n");

export default {
  title: "views/Compact Home",
};

export function Overview() {
  return (
    <StoryCard labelWidth="170px">
      <StoryRow
        label="composer pinned to the bottom"
        hint="393×852 with no homepage sections. The composer is an overlay at the bottom edge; with nothing scrolling behind it, the fade above it stays hidden."
      >
        <PhoneFrame>
          <CompactHomePage />
        </PhoneFrame>
      </StoryRow>
      <StoryRow
        label="keyboard open, long draft"
        hint="the keyboard leaves a short region; a tall draft scrolls inside the editor so the composer's top edge stays below the header"
      >
        <PhoneFrame heightClass="h-[480px]">
          <CompactHomePage composerValue={LONG_DRAFT} />
        </PhoneFrame>
      </StoryRow>
    </StoryCard>
  );
}
