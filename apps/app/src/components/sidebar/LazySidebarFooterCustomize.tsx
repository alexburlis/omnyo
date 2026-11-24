import { Skeleton } from "@omnyo/shared-ui/skeleton";
import { cn } from "@omnyo/shared-ui/lib/utils";
import { SidebarFooterCustomizeHeader } from "./SidebarFooterCustomizeHeader";
import { useSidebarFooterPreferences } from "./sidebarFooterPreferences";
import { defineSplit, SplitLoadFailure } from "@/lib/define-split";
import type { SidebarFooterCustomizeProps } from "./SidebarFooterCustomize";

function FooterCustomizePlaceholder({
  onDone,
  placement = "sidebar",
  retry,
}: SidebarFooterCustomizeProps & {
  retry?: () => void;
}) {
  const preferences = useSidebarFooterPreferences(placement);
  const isAppFooter = placement === "footer";

  return (
    <div
      className={cn("py-1", !isAppFooter && "rounded-lg bg-sidebar-accent/40")}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented) {
          event.preventDefault();
          onDone();
        }
      }}
    >
      <SidebarFooterCustomizeHeader onDone={onDone} autoFocus />
      {retry ? (
        <SplitLoadFailure retry={retry} />
      ) : (
        <div
          role="status"
          aria-label="Loading footer customization"
          className="space-y-1"
        >
          {preferences.items.map((item) => (
            <Skeleton key={item.key} className="h-10 w-full rounded-sm" />
          ))}
        </div>
      )}
    </div>
  );
}

export const LazySidebarFooterCustomize =
  defineSplit<SidebarFooterCustomizeProps>({
    id: "sidebar-footer-customize",
    load: () =>
      import("./SidebarFooterCustomize").then(
        (module) => module.SidebarFooterCustomize,
      ),
    loading: FooterCustomizePlaceholder,
    error: FooterCustomizePlaceholder,
  });
