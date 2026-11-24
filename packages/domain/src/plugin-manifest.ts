import { z } from "zod";
import { uiCodeThemeDeclarationSchema } from "./code-theme.js";
import {
  isNamespacedGlyph,
  isPluginOwnedIconPath,
  PLUGIN_ICON_NAME_MAX_LENGTH,
  PLUGIN_ICON_NAME_PATTERN,
  PLUGIN_ICONS_MAX_COUNT,
} from "./plugin-icon.js";

const requiredManifestString = z.string().trim().min(1);

const packageAuthorSchema = z
  .union([
    requiredManifestString.transform((value) => ({
      name: value.split(/\s*[<(]/u)[0]?.trim() ?? "",
      url: undefined,
    })),
    z.object({
      name: requiredManifestString,
      url: z.url({ protocol: /^https?$/u }).optional(),
    }),
  ])
  .transform(({ name, url }) => ({
    name,
    github:
      url?.match(/^https:\/\/github\.com\/([A-Za-z0-9-]+)\/?$/u)?.[1] ?? null,
    url: url ?? null,
  }));

const packageRepositorySchema = z.union([
  requiredManifestString.transform((url) => ({
    url,
    directory: undefined,
  })),
  z.object({
    url: requiredManifestString,
    directory: requiredManifestString.optional(),
  }),
]);

function httpsRepositoryUrl(url: string): URL | null {
  const hashIndex = url.indexOf("#");
  const location = hashIndex === -1 ? url : url.slice(0, hashIndex);
  const hash = hashIndex === -1 ? "" : url.slice(hashIndex);

  const github =
    /^(?:github:)?([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)$/u.exec(location)?.[1] ??
    /^(?:git\+)?(?:ssh:\/\/)?git@github\.com[:/]([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)$/u.exec(
      location,
    )?.[1];

  const candidate =
    github === undefined
      ? `${location.replace(/^git\+/u, "").replace(/^git:\/\//u, "https://")}${hash}`
      : `https://github.com/${github}${hash}`;

  try {
    const parsed = new URL(candidate);

    return parsed.protocol === "https:" ? parsed : null;
  } catch {
    return null;
  }
}

export function pluginRepositoryBrowseUrl(
  repositoryUrl: string,
  directory: string | undefined,
): string | null {
  const parsed = httpsRepositoryUrl(repositoryUrl);

  if (parsed === null) return null;
  const committish = parsed.hash.replace(/^#/u, "");
  parsed.hash = "";
  parsed.search = "";
  parsed.username = "";
  parsed.password = "";

  const repository = parsed
    .toString()
    .replace(/\/+$/u, "")
    .replace(/\.git$/u, "");

  const path = directory
    ?.split("/")
    .filter((segment) => segment !== "" && segment !== ".")
    .map(encodeURIComponent)
    .join("/");

  if (parsed.host !== "github.com") return repository;

  const ref = /^[A-Za-z0-9._/-]+$/u.test(committish) ? committish : "HEAD";

  if (path === undefined || path === "") {
    return ref === "HEAD" ? repository : `${repository}/tree/${ref}`;
  }

  return `${repository}/tree/${ref}/${path}`;
}

export function pluginRepositoryUrl(repository: unknown): string | null {
  const parsed = packageRepositorySchema.safeParse(repository);

  return parsed.success
    ? pluginRepositoryBrowseUrl(parsed.data.url, parsed.data.directory)
    : null;
}

const pluginBrandingIconsSchema = z
  .record(
    z
      .string()
      .max(
        PLUGIN_ICON_NAME_MAX_LENGTH,
        `icon names are at most ${PLUGIN_ICON_NAME_MAX_LENGTH} characters`,
      )
      .regex(
        PLUGIN_ICON_NAME_PATTERN,
        'icon names use lowercase letters, digits and "-", starting with a letter or digit',
      ),
    requiredManifestString.refine(
      (path) =>
        isPluginOwnedIconPath(path) && path.toLowerCase().endsWith(".svg"),
      {
        message:
          'icon paths are plugin-relative .svg files starting with "./" (for example "./icons/receipt.svg")',
      },
    ),
  )
  .refine((icons) => Object.keys(icons).length <= PLUGIN_ICONS_MAX_COUNT, {
    message: `a plugin declares at most ${PLUGIN_ICONS_MAX_COUNT} icons`,
  });

const pluginBrandingSchema = z
  .object({
    icon: requiredManifestString.optional(),
    logo: z
      .object({
        light: requiredManifestString,
        dark: requiredManifestString.optional(),
      })
      .strict()
      .optional(),
    experimental_icons: pluginBrandingIconsSchema.optional(),
  })
  .strict()
  .superRefine((branding, context) => {
    if (
      branding.icon !== undefined &&
      isPluginOwnedIconPath(branding.icon) &&
      !branding.icon.toLowerCase().endsWith(".svg")
    ) {
      context.addIssue({
        code: "custom",
        path: ["icon"],
        message:
          'plugin-owned branding.icon paths must point at an .svg file (for example "./assets/icon.svg")',
      });
    }

    if (branding.icon !== undefined && isNamespacedGlyph(branding.icon)) {
      context.addIssue({
        code: "custom",
        path: ["icon"],
        message: `"${branding.icon}" is a namespaced glyph ("<pluginId>/<name>"), which names a declared icon from a tool presentation or a provider declaration; branding.icon is the plugin's own mark, so name a host glyph ("Zap") or the SVG file itself ("./icons/logo.svg")`,
      });
    }
  })
  .refine(
    (branding) => branding.icon !== undefined || branding.logo !== undefined,
    {
      message: "must declare at least branding.icon or branding.logo.light",
    },
  );

export const pluginOmnyoManifestSchema = z
  .object({
    name: requiredManifestString,
    shortName: requiredManifestString.optional(),
    description: requiredManifestString,
    branding: pluginBrandingSchema,
    experimental_providers: z
      .array(
        z
          .object({
            kind: z.enum(["agent"]),
            id: requiredManifestString,
            displayName: requiredManifestString,
          })
          .strict(),
      )
      .optional(),
    server: requiredManifestString,
    app: requiredManifestString.optional(),
    host: requiredManifestString.optional(),
    skills: z.array(requiredManifestString).optional(),
    themes: z
      .array(
        z
          .object({
            id: z
              .string()
              .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/)
              .max(64),
            name: requiredManifestString,
            description: requiredManifestString.optional(),
            css: requiredManifestString,
            codeTheme: uiCodeThemeDeclarationSchema.optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

const pluginManifestV1ImportSchema = z
  .object({
    name: requiredManifestString,
    version: requiredManifestString,
    author: packageAuthorSchema.optional(),
    repository: z.unknown().optional(),
    engines: z
      .object({
        bb: requiredManifestString.optional(),
        bbPluginSdk: requiredManifestString.optional(),
        omnyo: requiredManifestString.optional(),
        omnyoPluginSdk: requiredManifestString.optional(),
      })
      .passthrough()
      .optional(),
    bb: pluginOmnyoManifestSchema.optional(),
    omnyo: pluginOmnyoManifestSchema.optional(),
  })
  .passthrough();

function manifestIdentity(
  manifest: z.infer<typeof pluginOmnyoManifestSchema>,
): string {
  return JSON.stringify(manifest, (_key, value: unknown) =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
        )
      : value,
  );
}

function importLegacyPluginManifestV1(
  {
    bb: legacyMetadata,
    omnyo,
    engines,
    ...packageJson
  }: z.infer<typeof pluginManifestV1ImportSchema>,
  context: z.RefinementCtx,
) {
  const selected = omnyo ?? legacyMetadata;

  if (selected === undefined) {
    context.addIssue({
      code: "custom",
      path: ["omnyo"],
      message: "must declare omnyo plugin metadata",
    });

    return z.NEVER;
  }

  if (
    legacyMetadata !== undefined &&
    omnyo !== undefined &&
    manifestIdentity(legacyMetadata) !== manifestIdentity(omnyo)
  ) {
    context.addIssue({
      code: "custom",
      path: ["omnyo"],
      message: "conflicting legacy and canonical plugin metadata",
    });

    return z.NEVER;
  }

  if (engines === undefined)
    return { ...packageJson, omnyo: selected, engines: undefined };

  const {
    bb: legacyCore,
    bbPluginSdk: legacySdk,
    ...canonicalEngines
  } = engines;

  for (const [legacy, canonical, key] of [
    [legacyCore, canonicalEngines.omnyo, "omnyo"],
    [legacySdk, canonicalEngines.omnyoPluginSdk, "omnyoPluginSdk"],
  ] as const) {
    if (
      legacy !== undefined &&
      canonical !== undefined &&
      legacy !== canonical
    ) {
      context.addIssue({
        code: "custom",
        path: ["engines", key],
        message: "conflicting legacy and canonical engine requirements",
      });

      return z.NEVER;
    }
  }

  return {
    ...packageJson,
    omnyo: selected,
    engines: {
      ...canonicalEngines,
      ...(canonicalEngines.omnyo === undefined && legacyCore !== undefined
        ? { omnyo: legacyCore }
        : {}),
      ...(canonicalEngines.omnyoPluginSdk === undefined &&
      legacySdk !== undefined
        ? { omnyoPluginSdk: legacySdk }
        : {}),
    },
  };
}

export const pluginPackageJsonSchema = pluginManifestV1ImportSchema.transform(
  importLegacyPluginManifestV1,
);

export type PluginPackageJson = z.infer<typeof pluginPackageJsonSchema>;
