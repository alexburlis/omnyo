import { TooltipProvider } from "@omnyo/shared-ui/tooltip";
import { ShowcaseExampleCard } from "@/components/showcase-hero/ShowcaseArchetypeCards";
import {
  BROWSE_ARCHETYPES,
  UTILITY_EXAMPLES,
  briefPrompt,
} from "./browse-hero-archetypes";

function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function BrowseArchetypeCards({
  onCreate,
}: {
  onCreate: (prompt: string) => void;
}) {
  return (
    <TooltipProvider delayDuration={250}>
      <section>
        <h3 className="text-xs font-medium text-subtle-foreground">
          Start from an example
        </h3>
        <div className="mt-2 grid grid-cols-[repeat(auto-fill,minmax(min(100%,18rem),1fr))] gap-2">
          {BROWSE_ARCHETYPES.map((archetype) => (
            <ShowcaseExampleCard
              key={archetype.id}
              icon={archetype.icon}
              title={archetype.title}
              description={archetype.hook}
              accentToken={archetype.accentToken}
              onClick={() => onCreate(briefPrompt(archetype))}
            />
          ))}
        </div>
        <h3 className="mt-5 text-xs font-medium text-subtle-foreground">
          Explore plugin capabilities
        </h3>
        <div className="mt-2 grid grid-cols-[repeat(auto-fill,minmax(min(100%,18rem),1fr))] gap-2">
          {UTILITY_EXAMPLES.map((example) => (
            <ShowcaseExampleCard
              key={example.id}
              icon={example.icon}
              title={example.label}
              description={sentenceCase(example.brief)}
              tooltip={briefPrompt(example)}
              onClick={() => onCreate(briefPrompt(example))}
            />
          ))}
        </div>
      </section>
    </TooltipProvider>
  );
}
