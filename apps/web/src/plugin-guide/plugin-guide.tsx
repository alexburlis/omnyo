import { OmnyoMark } from "../landing/site-chrome";
import { ProductMap } from "../../../../plugins/plugin-api-docs/src/product-map";
import { plainSurfaceCopy } from "../../../../plugins/plugin-api-docs/src/surface-copy";
import {
  GROUP_BY_SURFACE_ID,
  type PluginSurface,
} from "../../../../plugins/plugin-api-docs/src/surfaces";
import { BRAND_ICON_URL_BY_NAME } from "./plugin-directory";

function renderBrandIcon(displayName: string) {
  const url = BRAND_ICON_URL_BY_NAME.get(displayName);

  return url === undefined ? null : (
    <span
      aria-hidden
      className="inline-block size-3.5 shrink-0 bg-current text-subtle-foreground"
      style={{
        maskImage: `url("${url}")`,
        maskSize: "contain",
        maskRepeat: "no-repeat",
        maskPosition: "center",
      }}
    />
  );
}

export function pluginSurfaceAgentPrompt(
  surface: PluginSurface,
  origin: string,
): string {
  const group = GROUP_BY_SURFACE_ID.get(surface.id);
  const guideUrl = new URL("/plugin-guide", origin);

  if (group) guideUrl.searchParams.set("slide", group.id);

  return [
    `Build an Omnyo plugin that uses ${surface.title}.`,
    plainSurfaceCopy(surface.summary.replace(/ With this, a plugin can:$/, "")),
    `Plugin Guide surface: ${surface.title} (${surface.id}).`,
    `Relevant @omnyo/plugin-sdk symbols: ${surface.apiSymbols.join(", ")}.`,
    "Use the omnyo-plugin-authoring skill. Start the plugin with `omnyo plugin new <name>`, which pins the @omnyo/plugin-sdk declarations from your Omnyo install. In an existing plugin, run `omnyo plugin types` to sync them.",
    `Plugin Guide: ${guideUrl.href}`,
  ].join("\n");
}

async function copyForAgent(surface: PluginSurface): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
    return false;
  }

  try {
    await navigator.clipboard.writeText(
      pluginSurfaceAgentPrompt(surface, window.location.origin),
    );

    return true;
  } catch {
    return false;
  }
}

export default function PluginGuide({
  initialSlideId,
  onSlideChange,
}: {
  initialSlideId?: string;
  onSlideChange?: (slideId: string) => void;
}) {
  return (
    <ProductMap
      renderPluginIcon={renderBrandIcon}
      initialSlideId={initialSlideId}
      onSlideChange={onSlideChange}
      onCopyForAgent={copyForAgent}
      mobileOnlyOnCompactViewport
      brandMark={
        <span role="img" aria-label="Omnyo">
          <OmnyoMark className="inline-block h-[0.9em] w-auto align-[-0.1em]" />
        </span>
      }
    />
  );
}
