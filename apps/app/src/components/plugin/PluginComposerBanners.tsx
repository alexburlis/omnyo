import { useMemo, type ReactNode } from "react";
import type { ComposerView } from "@omnyo/plugin-sdk";
import { PromptStackCard } from "@/components/promptbox/banner/PromptStackCard";
import { useResolvedComposerBanners } from "./composer-slot-hooks";
import { PluginSlotMount } from "./PluginSlotMount";
import {
  composerScopeIdentity,
  PluginComposerViewProvider,
  useOptionalPluginComposerStaticView,
} from "./plugin-composer-host";

export function ComposerBannersSlot({
  view,
  children,
  ownerPlacement = "after",
  attachedToComposer = null,
}: {
  view?: ComposerView;
  children?: ReactNode;
  ownerPlacement?: "before" | "after";
  attachedToComposer?: ReactNode;
}) {
  return view === undefined ? (
    <ComposerBannerRows
      ownerPlacement={ownerPlacement}
      attachedToComposer={attachedToComposer}
    >
      {children}
    </ComposerBannerRows>
  ) : (
    <PluginComposerViewProvider value={view}>
      <ComposerBannerRows
        ownerPlacement={ownerPlacement}
        attachedToComposer={attachedToComposer}
      >
        {children}
      </ComposerBannerRows>
    </PluginComposerViewProvider>
  );
}

function ComposerBannerRows({
  children,
  ownerPlacement,
  attachedToComposer,
}: {
  children?: ReactNode;
  ownerPlacement: "before" | "after";
  attachedToComposer: ReactNode;
}) {
  const view = useOptionalPluginComposerStaticView();
  const banners = useResolvedComposerBanners(view?.scope.kind ?? null);

  const scopeKey =
    view === undefined ? null : composerScopeIdentity(view.scope);

  const { adjacentRows, defaultRows } = useMemo(() => {
    const rows = banners.map(({ key, pluginId, customizationId, banner }) => {
      const slotId = `${customizationId}/${banner.id}`;

      return {
        adjacent: banner.experimental_placement === "adjacent-to-composer",
        node: (
          <PluginSlotMount
            key={`${key}/${scopeKey ?? "unbound"}`}
            pluginId={pluginId}
            slotKind="composerBanner"
            slotId={slotId}
            crashFallback={<></>}
          >
            {banner.chrome === "bare" ? (
              <banner.component />
            ) : (
              <PromptStackCard ariaLabel={pluginId} className="empty:hidden">
                <banner.component />
              </PromptStackCard>
            )}
          </PluginSlotMount>
        ),
      };
    });

    return {
      adjacentRows: rows.filter((row) => row.adjacent).map((row) => row.node),
      defaultRows: rows.filter((row) => !row.adjacent).map((row) => row.node),
    };
  }, [banners, scopeKey]);

  return (
    <>
      {ownerPlacement === "before" ? children : null}
      {defaultRows}
      {ownerPlacement === "after" ? children : null}
      {adjacentRows.length === 0 ? null : (
        <div
          data-composer-banner-row=""
          className="hidden min-w-0 flex-wrap items-stretch gap-2 has-[>[data-omnyo-plugin-root]>:not(:empty)]:flex"
        >
          {adjacentRows}
        </div>
      )}
      {attachedToComposer}
    </>
  );
}
