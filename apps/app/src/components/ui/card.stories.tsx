import { useState } from "react";
import { Button } from "@omnyo/shared-ui/button";
import {
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@omnyo/shared-ui/card";
import { Icon } from "@omnyo/shared-ui/icon";
import { getStaggerItemProps } from "@omnyo/shared-ui/motion";
import { Progress } from "@omnyo/shared-ui/progress";
import { SuccessCheck } from "@omnyo/shared-ui/success-check";

export default {
  title: "ui/Card",
};

const TEMPLATES = [
  {
    icon: "Workflow",
    title: "Weekly Content Feed",
    body: "Seven reviewed drafts and a delivery calendar from your startup’s facts.",
  },
  {
    icon: "GitPullRequest",
    title: "Release review",
    body: "Independent checks before anything ships to your users.",
  },
  {
    icon: "Search",
    title: "Competitor scan",
    body: "A weekly summary of what changed on the sites you track.",
  },
] as const;

export function Overview() {
  return (
    <div className="m-6 grid max-w-3xl gap-4 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Default</CardTitle>
          <CardDescription>
            A raised surface: hairline border and a soft shadow.
          </CardDescription>
        </CardHeader>
        <CardFooter>
          <Button>Primary action</Button>
          <Button variant="ghost">Cancel</Button>
        </CardFooter>
      </Card>
      <Card variant="recessed">
        <CardHeader>
          <CardTitle>Recessed</CardTitle>
          <CardDescription>
            A sunken well for secondary content inside a page.
          </CardDescription>
        </CardHeader>
      </Card>
      <Card variant="interactive" tabIndex={0}>
        <CardHeader>
          <CardTitle>Interactive</CardTitle>
          <CardDescription>
            Hover lifts it by a pixel with a deeper shadow.
          </CardDescription>
        </CardHeader>
      </Card>
      <Card variant="flat">
        <CardHeader>
          <CardTitle>Flat</CardTitle>
          <CardDescription>Border only, for dense lists.</CardDescription>
        </CardHeader>
      </Card>
    </div>
  );
}

export function RevealAndConfirm() {
  const [shown, setShown] = useState(false);
  const [saved, setSaved] = useState(false);
  const [progress, setProgress] = useState(20);

  return (
    <div className="m-6 flex max-w-3xl flex-col gap-6">
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          onClick={() => setShown((value) => !value)}
          data-testid="reveal-templates"
        >
          {shown ? "Hide templates" : "Show templates"}
        </Button>
        <Button
          onClick={() => setSaved((value) => !value)}
          data-testid="confirm-save"
        >
          {saved ? "Reset" : "Save"}
        </Button>
        {saved ? (
          <span className="flex items-center gap-2 text-sm text-muted-foreground">
            <SuccessCheck animate label="Saved" />
            Saved
          </span>
        ) : null}
        <Button
          variant="ghost"
          onClick={() =>
            setProgress((value) => (value >= 100 ? 20 : value + 40))
          }
          data-testid="advance-progress"
        >
          Advance progress
        </Button>
      </div>
      <Progress value={progress} aria-label="Import progress" />
      {shown ? (
        <div className="grid gap-3 md:grid-cols-3">
          {TEMPLATES.map((template, index) => {
            const stagger = getStaggerItemProps(index, TEMPLATES.length, true);

            return (
              <Card
                key={template.title}
                variant="interactive"
                tabIndex={0}
                className={stagger.className}
                style={stagger.style}
              >
                <CardHeader>
                  <span className="mb-1 grid size-8 place-items-center rounded-lg bg-state-hover text-muted-foreground">
                    <Icon
                      name={template.icon}
                      className="size-4"
                      aria-hidden="true"
                    />
                  </span>
                  <CardTitle className="text-sm">{template.title}</CardTitle>
                  <CardDescription className="text-xs">
                    {template.body}
                  </CardDescription>
                </CardHeader>
              </Card>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
