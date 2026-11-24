import { useState } from "react";
import { Button } from "@omnyo/shared-ui/button";
import { Icon } from "@omnyo/shared-ui/icon";
import {
  INERT_TYPEAHEAD_COMMAND_CONFIG,
  PromptBoxInternal,
} from "./PromptBoxInternal";

export default { title: "Promptbox/Composer rail" };

export function Crowded() {
  const [value, setValue] = useState("Review this change.");
  const [width, setWidth] = useState(720);
  const [lastAction, setLastAction] = useState("None");

  return (
    <div className="flex flex-col gap-4">
      <label>
        Rail width{" "}
        <input
          aria-label="Rail width"
          type="number"
          min={280}
          max={1200}
          value={width}
          onChange={(event) => setWidth(Number(event.target.value))}
        />
      </label>
      <output>Last action: {lastAction}</output>
      <div style={{ width, maxWidth: "100%" }}>
        <PromptBoxInternal
          value={value}
          mentionRanges={[]}
          onChange={setValue}
          onSubmit={() => setLastAction("Send")}
          mentionMenuPlacement="top"
          typeahead={{
            mention: {
              results: { groups: [], suggestions: [] },
              isLoading: false,
              isRefreshing: false,
              isError: false,
              onQueryChange: () => {},
            },
            command: INERT_TYPEAHEAD_COMMAND_CONFIG,
          }}
          footerStart={
            <>
              <Button
                variant="ghost"
                size="sm"
                className="min-w-0 max-w-full"
                onClick={() => setLastAction("Model")}
              >
                <Icon name="Sparkles" className="size-4 shrink-0" />
                <span className="truncate">A model with a very long name</span>
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Session options"
                onClick={() => setLastAction("Session options")}
              >
                <Icon name="Settings2" className="size-4" />
              </Button>
            </>
          }
          submitAccessory={
            <>
              {[
                "Plugin action one",
                "Plugin action two",
                "Plugin action three",
                "Compact 753k tokens",
                "Context usage",
                "Permissions",
              ].map((label) => (
                <Button
                  key={label}
                  variant="ghost"
                  size="sm"
                  className="min-w-0 max-w-full"
                  onClick={() => setLastAction(label)}
                >
                  {label}
                </Button>
              ))}
            </>
          }
          voice={{
            state: "idle",
            microphoneWarning: null,
            isSupported: true,
            stream: null,
            start: () => setLastAction("Voice"),
            stop: () => {},
            send: () => {},
            cancel: () => {},
          }}
        />
      </div>
    </div>
  );
}
