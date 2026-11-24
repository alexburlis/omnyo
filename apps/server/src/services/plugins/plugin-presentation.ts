import type { ThreadEventItemPresentation } from "@omnyo/domain";
import { isNamespacedGlyph, isPluginOwnedIconPath } from "@omnyo/domain";
import type { PluginRowPresentation } from "@omnyo/plugin-sdk";

export const GENERIC_PLUGIN_GLYPH = "Toolbox";

export function fillPluginPresentation(args: {
  declared: PluginRowPresentation | null;
  brandingIcon: string | undefined;
  label: { pending: string; completed: string };
}): ThreadEventItemPresentation {
  const { declared, brandingIcon } = args;

  const glyph =
    declared?.icon?.glyph ??
    (brandingIcon !== undefined &&
    !isPluginOwnedIconPath(brandingIcon) &&
    !isNamespacedGlyph(brandingIcon)
      ? brandingIcon
      : GENERIC_PLUGIN_GLYPH);

  return {
    label: declared?.label ?? args.label,
    icon: { glyph },
    ...(declared?.suppress === undefined
      ? {}
      : { suppress: declared.suppress }),
    ...(declared?.tint === undefined ? {} : { tint: declared.tint }),
  };
}
