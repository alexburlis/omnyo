import { Command } from "commander";
import {
  EXPLORE_KINDS,
  EXPLORE_MARKETPLACE_KINDS,
  EXPLORE_MARKETPLACE_CATEGORIES,
  ExploreFormatError,
  ExploreUnavailableError,
  exploreUrl,
  filterExploreItems,
  filterExploreSkills,
  filterExploreMarketplace,
  parseExploreKey,
  readExploreCatalog,
  readExploreSkills,
  readExploreMarketplace,
  readExplorePromptText,
  type ExploreItem,
  type ExploreKind,
  type ExploreReadOptions,
} from "@omnyo/sdk/explore";
import { action, CliExitError, CliUsageError } from "../action.js";
import { cliFetch } from "../client.js";
import { columnWidths, printBorderlessTable } from "../table.js";
import { outputJson } from "./helpers.js";

interface ExploreCommandOptions {
  category?: string;
  publisher?: string;
  json?: boolean;
  query?: string;
  text?: boolean;
  type?: string;
}

interface ExploreCommandDeps {
  fetch?: typeof fetch;
}

type ExploreRow = ExploreItem & { url: string };

const EXPLORE_UNAVAILABLE_HINT =
  "The public catalog at https://omnyohq.com may not be published yet. Try again later.";

function toRow(item: ExploreItem): ExploreRow {
  return { ...item, url: exploreUrl(item.path) };
}

function parseKind(value: string): ExploreKind {
  const kind = EXPLORE_KINDS.find((candidate) => candidate === value);

  if (kind === undefined) {
    throw new CliUsageError({
      code: "invalid_value",
      hint: `Use one of: ${EXPLORE_KINDS.join(", ")}.`,
      message: `Invalid --type '${value}'.`,
    });
  }

  return kind;
}

function unavailable(
  error: ExploreUnavailableError | ExploreFormatError,
): CliExitError {
  return new CliExitError(error.message, 1, {
    code: "explore_unavailable",
    hint: EXPLORE_UNAVAILABLE_HINT,
  });
}

async function withExploreErrors<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (
      error instanceof ExploreUnavailableError ||
      error instanceof ExploreFormatError
    ) {
      throw unavailable(error);
    }

    throw error;
  }
}

function nextStep(item: ExploreItem): string {
  const { cta } = item;

  switch (cta.kind) {
    case "copy-prompt":
      return `Prompt text: omnyo explore prompt/${item.slug} --text`;
    case "get-workflow":
      return `Get the workflow: ${exploreUrl(cta.path)}`;
    case "get-skill-pack":
      return `View the skill pack: ${exploreUrl(cta.path)}`;
    case "find-in-omnyo":
      return `Find it in Omnyo under Plugins, or run: ${cta.install}`;
    case "read-guide":
      return `Read the guide: ${exploreUrl(cta.path)}`;
  }
}

function printItems(items: readonly ExploreItem[]): void {
  if (items.length === 0) {
    console.log("No Explore items match.");

    return;
  }

  const rows = items.map((item) => [
    `${item.kind}/${item.slug}`,
    item.title,
    exploreUrl(item.path),
  ]);

  printBorderlessTable(
    {
      head: ["KEY", "TITLE", "URL"],
      colWidths: columnWidths(rows, [3, 5, 3]),
      trimTrailingWhitespace: true,
    },
    rows,
  );
}

function printItem(item: ExploreItem): void {
  console.log(item.title);
  console.log(`Type: ${item.kind} · By ${item.publisher}`);
  console.log(item.summary);
  console.log(`URL: ${exploreUrl(item.path)}`);
  console.log(nextStep(item));
}

function notFound(key: string): CliExitError {
  return new CliExitError(`No Explore item '${key}'.`, 1, {
    code: "explore_not_found",
    hint: "Run omnyo explore to list the available items.",
  });
}

function usage(message: string, hint: string): CliUsageError {
  return new CliUsageError({ code: "invalid_value", hint, message });
}

async function runExplore(
  key: string | undefined,
  opts: ExploreCommandOptions,
  readOptions: ExploreReadOptions,
): Promise<void> {
  if (key === "marketplace") {
    if (opts.text === true)
      throw usage(
        "marketplace cannot be combined with --text.",
        "Run: omnyo explore marketplace [--type skill|workflow|connector] [--json]",
      );

    const kind =
      opts.type === undefined
        ? undefined
        : EXPLORE_MARKETPLACE_KINDS.find((value) => value === opts.type);

    if (opts.type !== undefined && kind === undefined)
      throw usage(
        `Invalid marketplace --type '${opts.type}'.`,
        `Use one of: ${EXPLORE_MARKETPLACE_KINDS.join(", ")}.`,
      );

    const category =
      opts.category === undefined
        ? undefined
        : EXPLORE_MARKETPLACE_CATEGORIES.find(
            (value) => value === opts.category,
          );

    if (opts.category !== undefined && category === undefined)
      throw usage(
        `Invalid marketplace --category '${opts.category}'.`,
        `Use one of: ${EXPLORE_MARKETPLACE_CATEGORIES.join(", ")}.`,
      );

    const catalog = await withExploreErrors(() =>
      readExploreMarketplace(readOptions),
    );

    const items = filterExploreMarketplace(catalog.items, {
      kind,
      category,
      publisher: opts.publisher,
      query: opts.query,
    });

    if (outputJson(opts, { items })) return;

    if (items.length === 0) {
      console.log("No Marketplace items match.");

      return;
    }

    const rows = items.map((item) => [
      item.kind,
      item.title,
      item.publisher,
      exploreUrl(item.detailPath),
    ]);

    printBorderlessTable(
      {
        head: ["TYPE", "TITLE", "PUBLISHER", "URL"],
        colWidths: columnWidths(rows, [4, 5, 9, 3]),
        trimTrailingWhitespace: true,
      },
      rows,
    );

    return;
  }

  if (opts.category !== undefined || opts.publisher !== undefined)
    throw usage(
      "--category and --publisher require marketplace.",
      "Run: omnyo explore marketplace [--category <category>] [--publisher <publisher>] [--json]",
    );

  if (key === "skills") {
    if (opts.text === true || opts.type !== undefined) {
      throw usage(
        "skills cannot be combined with --text or --type.",
        "Run: omnyo explore skills [--query <text>] [--json]",
      );
    }

    const catalog = await withExploreErrors(() =>
      readExploreSkills(readOptions),
    );

    const items = filterExploreSkills(catalog.items, { query: opts.query });

    if (outputJson(opts, { items })) return;

    if (items.length === 0) {
      console.log("No Explore skills match.");

      return;
    }

    const rows = items.map((item) => [
      item.slug,
      item.title,
      item.publisher,
      exploreUrl(item.detailPath),
    ]);

    printBorderlessTable(
      {
        head: ["SLUG", "TITLE", "PUBLISHER", "URL"],
        colWidths: columnWidths(rows, [4, 5, 9, 3]),
        trimTrailingWhitespace: true,
      },
      rows,
    );

    return;
  }

  if (opts.text === true) {
    const parsed = key === undefined ? null : parseExploreKey(key);

    if (parsed === null || parsed.kind !== "prompt") {
      throw usage(
        "--text needs a prompt key.",
        "Run: omnyo explore prompt/<slug> --text",
      );
    }

    if (
      opts.json === true ||
      opts.type !== undefined ||
      opts.query !== undefined
    ) {
      throw usage(
        "--text cannot be combined with --json, --type or --query.",
        "Run: omnyo explore prompt/<slug> --text",
      );
    }

    const text = await withExploreErrors(async () => {
      try {
        return await readExplorePromptText(parsed.slug, readOptions);
      } catch (error) {
        if (!(error instanceof ExploreUnavailableError) || error.status !== 404)
          throw error;

        const catalog = await readExploreCatalog(readOptions);

        if (
          catalog.items.some(
            (item) => item.kind === "prompt" && item.slug === parsed.slug,
          )
        )
          throw error;

        throw notFound(key ?? "");
      }
    });

    process.stdout.write(text);

    return;
  }

  if (key !== undefined) {
    const parsed = parseExploreKey(key);

    if (parsed === null) {
      throw usage(
        `Invalid Explore key '${key}'.`,
        `Use <type>/<slug> with type one of: ${EXPLORE_KINDS.join(", ")}.`,
      );
    }

    if (opts.type !== undefined || opts.query !== undefined) {
      throw usage(
        "--type and --query filter the list; they cannot be combined with a key.",
        "Run omnyo explore without a key to filter.",
      );
    }

    const catalog = await withExploreErrors(() =>
      readExploreCatalog(readOptions),
    );

    const item = catalog.items.find(
      (candidate) =>
        candidate.kind === parsed.kind && candidate.slug === parsed.slug,
    );

    if (item === undefined) throw notFound(key);

    if (outputJson(opts, { item: toRow(item) })) return;
    printItem(item);

    return;
  }

  const kind = opts.type === undefined ? undefined : parseKind(opts.type);

  const catalog = await withExploreErrors(() =>
    readExploreCatalog(readOptions),
  );

  const items = filterExploreItems(catalog.items, { kind, query: opts.query });

  if (outputJson(opts, { items: items.map(toRow) })) return;
  printItems(items);
}

export function registerExploreCommand(
  program: Command,
  deps: ExploreCommandDeps = {},
): void {
  program
    .command("explore")
    .description(
      "Browse the public Omnyo Explore catalog of skill packs, prompts, workflows, plugins and guides",
    )
    .argument(
      "[key]",
      "Show <type>/<slug>, use skills for source skills, or marketplace for skills, workflows and connectors",
    )
    .option(
      "--type <type>",
      `Filter Explore by ${EXPLORE_KINDS.join(", ")}; marketplace accepts skill, workflow, connector`,
    )
    .option("--query <text>", "Only list items matching every word of the text")
    .option("--category <category>", "Filter marketplace by an exact category")
    .option(
      "--publisher <publisher>",
      "Filter marketplace by an exact publisher",
    )
    .option("--text", "Print a prompt's exact text (needs a prompt key)")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (key: string | undefined, opts: ExploreCommandOptions) => {
        await runExplore(key, opts, { fetch: deps.fetch ?? cliFetch });
      }),
    );
}
