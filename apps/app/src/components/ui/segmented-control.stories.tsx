import { useState } from "react";
import { SegmentedControl } from "@omnyo/shared-ui/segmented-control";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";

export default {
  title: "ui/Segmented Control",
};

type View = "preview" | "source";

type Range = "day" | "week" | "month" | "year";

type Layout = "stacked" | "split";

export function Overview() {
  const [view, setView] = useState<View>("preview");
  const [range, setRange] = useState<Range>("week");
  const [layout, setLayout] = useState<Layout>("stacked");
  const [compact, setCompact] = useState<Range>("day");

  return (
    <StoryCard>
      <StoryRow label="two options" hint="one indicator slides between them">
        <SegmentedControl
          ariaLabel="File view"
          value={view}
          onValueChange={setView}
          options={[
            { value: "preview", label: "Preview" },
            { value: "source", label: "Raw" },
          ]}
        />
      </StoryRow>
      <StoryRow label="four options" hint="arrow keys move the selection">
        <SegmentedControl
          ariaLabel="Usage range"
          value={range}
          onValueChange={setRange}
          options={[
            { value: "day", label: "Day" },
            { value: "week", label: "Week" },
            { value: "month", label: "Month" },
            { value: "year", label: "Year", disabled: true },
          ]}
        />
      </StoryRow>
      <StoryRow label="icons" hint="icon segments carry an aria-label">
        <SegmentedControl
          ariaLabel="Diff layout"
          size="sm"
          value={layout}
          onValueChange={setLayout}
          options={[
            {
              value: "stacked",
              label: "Stacked",
              icon: "Rows2",
            },
            {
              value: "split",
              label: "Split",
              icon: "Columns2",
            },
          ]}
        />
      </StoryRow>
      <StoryRow label="full width" hint="fills its container">
        <div className="w-96">
          <SegmentedControl
            ariaLabel="Compact range"
            size="sm"
            fullWidth
            value={compact}
            onValueChange={setCompact}
            options={[
              { value: "day", label: "Today" },
              { value: "week", label: "This week" },
              { value: "month", label: "This month" },
            ]}
          />
        </div>
      </StoryRow>
    </StoryCard>
  );
}
