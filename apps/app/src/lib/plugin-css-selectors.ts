function splitSelectors(value: string): string[] {
  const selectors: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];

    if (char === "\\") {
      index += 1;
      continue;
    }

    if (quote !== null) {
      if (char === quote) quote = null;
      continue;
    }

    if (char === '"' || char === "'") quote = char;
    else if (char === "(" || char === "[") depth += 1;
    else if (char === ")" || char === "]") depth -= 1;
    else if (char === "," && depth === 0) {
      selectors.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }

  selectors.push(value.slice(start).trim());

  return selectors;
}

function functionEnd(value: string): number {
  let depth = 0;
  let quote: string | null = null;

  for (let index = value.indexOf("("); index < value.length; index += 1) {
    const char = value[index];

    if (char === "\\") {
      index += 1;
      continue;
    }

    if (quote !== null) {
      if (char === quote) quote = null;
      continue;
    }

    if (char === '"' || char === "'") quote = char;
    else if (char === "(") depth += 1;
    else if (char === ")" && --depth === 0) return index;
  }

  return -1;
}

function unwrapScopedPair(selector: string, scope: string): string[] {
  if (!selector.startsWith(`:is(${scope} `)) return [selector];
  const end = functionEnd(selector);

  if (end < 0) return [selector];
  const pair = splitSelectors(selector.slice(4, end));
  const [descendant, self] = pair;

  if (
    pair.length !== 2 ||
    descendant === undefined ||
    self === undefined ||
    !descendant.startsWith(`${scope} `) ||
    !self.startsWith(scope) ||
    descendant.includes("::") ||
    self.includes("::") ||
    descendant.slice(scope.length + 1) !== self.slice(scope.length)
  )
    return [selector];

  const suffix = selector.slice(end + 1);

  return [`${descendant}${suffix}`, `${self}${suffix}`];
}

function isStyleRule(rule: CSSRule): rule is CSSStyleRule {
  return rule.type === CSSRule.STYLE_RULE;
}

function hasChildRules(
  rule: CSSRule,
): rule is CSSRule & { cssRules: CSSRuleList } {
  return (
    "cssRules" in rule && rule.cssRules !== undefined && rule.cssRules !== null
  );
}

export function normalizePluginStylesheet(
  sheet: CSSStyleSheet,
  pluginId: string,
): number {
  const attributed = `[data-omnyo-plugin="${pluginId}"]`;
  const preview = "[data-omnyo-plugin-root]:not([data-omnyo-plugin])";
  const scope = `:where(${attributed}, ${preview})`;
  let normalized = 0;

  const visit = (rules: CSSRuleList): void => {
    for (const rule of rules) {
      const children = hasChildRules(rule) ? rule.cssRules : null;

      if (children !== null) visit(children);

      if (!isStyleRule(rule) || (children !== null && children.length > 0))
        continue;

      const originalSelectors = splitSelectors(rule.selectorText);

      const selectors = originalSelectors.flatMap((selector) =>
        unwrapScopedPair(selector, scope).flatMap((arm) =>
          arm.startsWith(scope) && arm.split(scope).length === 2
            ? [
                arm.replace(scope, `:where(${attributed})`),
                arm.replace(scope, `:where(${preview})`),
              ]
            : [arm],
        ),
      );

      if (selectors.length === originalSelectors.length) continue;
      const next = selectors.join(", ");

      if (next === rule.selectorText) continue;
      rule.selectorText = next;
      normalized += 1;
    }
  };

  visit(sheet.cssRules);

  return normalized;
}

type RuleParent = CSSStyleSheet | CSSGroupingRule;

function groupingPrelude(rule: CSSRule): string | null {
  if (rule instanceof CSSMediaRule) return `@media ${rule.media.mediaText}`;

  if (typeof CSSSupportsRule !== "undefined" && rule instanceof CSSSupportsRule)
    return `@supports ${rule.conditionText}`;

  if (
    typeof CSSLayerBlockRule !== "undefined" &&
    rule instanceof CSSLayerBlockRule
  )
    return `@layer ${rule.name}`;

  if (
    typeof CSSContainerRule !== "undefined" &&
    rule instanceof CSSContainerRule
  )
    return `@container ${rule.conditionText}`;

  return null;
}

function isLeafStyleRule(rule: CSSRule): rule is CSSStyleRule {
  return (
    isStyleRule(rule) && (!hasChildRules(rule) || rule.cssRules.length === 0)
  );
}

function visitLeafStyleRules(
  parent: RuleParent,
  chain: string,
  visit: (
    rule: CSSStyleRule,
    chain: string,
    parent: RuleParent,
    index: number,
  ) => void,
): void {
  const rules = parent.cssRules;

  for (let index = rules.length - 1; index >= 0; index -= 1) {
    const rule = rules[index];

    if (rule === undefined) continue;

    if (isLeafStyleRule(rule)) {
      visit(rule, chain, parent, index);
      continue;
    }

    if (!(rule instanceof CSSGroupingRule)) continue;
    const prelude = groupingPrelude(rule);

    if (prelude !== null)
      visitLeafStyleRules(rule, `${chain}${prelude}\u0000`, visit);
  }
}

const hostRuleIndexes = new WeakMap<
  CSSStyleSheet,
  ReadonlyMap<string, string | null>
>();

function hostRuleIndex(
  sheet: CSSStyleSheet,
): ReadonlyMap<string, string | null> {
  const cached = hostRuleIndexes.get(sheet);

  if (cached !== undefined) return cached;
  const index = new Map<string, string | null>();

  try {
    visitLeafStyleRules(sheet, "", (rule, chain) => {
      const declarations = rule.style.cssText;

      for (const selector of splitSelectors(rule.selectorText)) {
        const key = `${chain}${selector}`;

        index.set(
          key,
          index.has(key) && index.get(key) !== declarations
            ? null
            : declarations,
        );
      }
    });
  } catch {
    return index;
  }

  hostRuleIndexes.set(sheet, index);

  return index;
}

function unscopedArm(arm: string, scopes: readonly string[]): string | null {
  const scope = scopes.find((candidate) => arm.startsWith(candidate));

  if (scope === undefined) return null;
  const rest = arm.slice(scope.length);
  const base = rest.startsWith(" ") ? rest.slice(1) : rest;

  return base.length === 0 ? null : base;
}

function unscopedSelector(
  selectorText: string,
  scopes: readonly string[],
): string | null {
  const bases = new Set(
    splitSelectors(selectorText).map((arm) => unscopedArm(arm, scopes)),
  );

  const [base] = bases;

  return bases.size === 1 ? (base ?? null) : null;
}

interface PluginLeafRule {
  rule: CSSStyleRule;
  chain: string;
  parent: RuleParent;
  index: number;
}

export function dropHostDuplicatePluginRules(
  sheet: CSSStyleSheet,
  pluginId: string,
  hostSheets: Iterable<CSSStyleSheet>,
): number {
  const indexes = [...hostSheets].map(hostRuleIndex);

  const scopes = [
    `:where([data-omnyo-plugin="${pluginId}"])`,
    ":where([data-omnyo-plugin-root]:not([data-omnyo-plugin]))",
  ];

  const leaves: PluginLeafRule[] = [];

  visitLeafStyleRules(sheet, "", (rule, chain, parent, index) => {
    leaves.push({ rule, chain, parent, index });
  });

  const keptBases = new Set<string>();
  const drops: PluginLeafRule[] = [];

  for (const leaf of leaves.reverse()) {
    const base = unscopedSelector(leaf.rule.selectorText, scopes);
    const declarations = leaf.rule.style.cssText;

    if (
      base !== null &&
      !keptBases.has(base) &&
      indexes.some((host) => host.get(`${leaf.chain}${base}`) === declarations)
    ) {
      drops.push(leaf);
      continue;
    }

    for (const arm of splitSelectors(leaf.rule.selectorText))
      keptBases.add(unscopedArm(arm, scopes) ?? arm);
  }

  for (const { parent, index } of drops.reverse()) parent.deleteRule(index);

  return drops.length;
}
