import { useState } from "react";
import { Button } from "@omnyo/shared-ui/button";
import { QuestionForm } from "@/components/ui/question-form";
import { PageShell } from "@/components/ui/page-shell";
import { PendingInteractionShell } from "@/components/thread/pending-interactions/PendingInteractionShell";
import { MobilePendingInteractionProvider } from "@/components/thread/pending-interactions/MobilePendingInteraction";
import { ComposerBannerStack } from "./ComposerBannerStack";
import { ProviderRequirementBanner } from "./banner/ProviderRequirementBanner";

export default { title: "promptbox/Mobile Chat Spacing" };

const questions = [
  {
    id: "spacing",
    prompt: "Which implementation should we use for the next version?",
    shortLabel: "Implementation",
    multiSelect: false,
    allowFreeText: true,
    additiveNotes: true,
    options: Array.from({ length: 12 }, (_, index) => ({
      value: String(index),
      label: `Option ${index + 1}`,
      description:
        "A complete description that needs room to wrap on a narrow phone screen without cutting off the details.",
    })),
  },
];

export function Conversation() {
  const [resolved, setResolved] = useState(false);
  const [result, setResult] = useState("Waiting for an answer");

  return (
    <div
      data-mobile-spacing-preview=""
      className="mx-auto flex h-[calc(100dvh-32px)] max-w-[760px] flex-col overflow-hidden bg-background"
    >
      <header className="shrink-0 border-b border-border px-4 py-3 font-medium">
        Mobile chat spacing
      </header>
      <PageShell
        scrollBehavior="bottom-anchor"
        shellClassName="!m-0"
        footer={
          <MobilePendingInteractionProvider>
            <ComposerBannerStack>
              {!resolved ? (
                <PendingInteractionShell
                  label="Needs your answer"
                  expandedByDefault
                  testId="spacing-question"
                >
                  {() => (
                    <QuestionForm
                      draftKey="mobile-spacing-story"
                      questions={questions}
                      disabled={false}
                      cancelDisabled={false}
                      cancelLabel="Skip"
                      onSubmit={async () => {
                        setResult("Answer sent");
                        setResolved(true);
                      }}
                      onCancel={async () => {
                        setResult("Question skipped");
                        setResolved(true);
                      }}
                    />
                  )}
                </PendingInteractionShell>
              ) : null}
              <PendingInteractionShell
                label="Another decision"
                expandedByDefault
                testId="spacing-second-question"
              >
                {() => <p>A second request must not cover the first one.</p>}
              </PendingInteractionShell>
              <ProviderRequirementBanner
                title="Provider update required"
                description="Update this provider before starting another turn. The existing conversation remains available."
                action={<Button size="sm">Update provider</Button>}
              />
              {Array.from({ length: 5 }, (_, index) => (
                <div
                  key={index}
                  className="rounded-md border border-border px-3 py-2 text-xs text-muted-foreground"
                >
                  Background status {index + 1}. Details remain reachable by
                  scrolling.
                </div>
              ))}
            </ComposerBannerStack>
            <textarea
              data-spacing-reply=""
              aria-label="Chat reply"
              placeholder="Reply…"
              className="mt-2 min-h-16 w-full resize-none rounded-lg border border-border bg-background p-3 text-sm"
            />
          </MobilePendingInteractionProvider>
        }
      >
        <p className="py-3 text-muted-foreground">
          The conversation keeps its space while status cards collect above the
          reply box.
        </p>
        <p role="status">{result}</p>
        <p className="mt-auto py-6">The latest chat message stays readable.</p>
      </PageShell>
    </div>
  );
}
