import "./github.css";

import GithubIcon from "@hugeicons/core-free-icons/GithubIcon";
import { HugeiconsIcon } from "@hugeicons/react";

import { GITHUB_URL } from "./site";

export const GITHUB_NAME = "Omnyo releases on GitHub";

export function GitHubGlyph({
  className = "gh-glyph",
}: {
  className?: string;
}) {
  return <HugeiconsIcon icon={GithubIcon} className={className} aria-hidden />;
}

export function GitHubButton({
  href = GITHUB_URL,
  label = "Releases on GitHub",
  short,
  iconOnly = false,
  className = "",
}: {
  href?: string;
  label?: string;
  short?: string;
  iconOnly?: boolean;
  className?: string;
}) {
  const classes = ["gh-btn", iconOnly ? "gh-btn--icon" : "", className]
    .filter(Boolean)
    .join(" ");

  if (iconOnly) {
    return (
      <a className={classes} href={href} aria-label={GITHUB_NAME}>
        <GitHubGlyph />
      </a>
    );
  }

  return (
    <a className={classes} href={href}>
      <GitHubGlyph />
      <span className={short ? "gh-btn-long" : undefined}>{label}</span>
      {short ? <span className="gh-btn-short">{short}</span> : null}
    </a>
  );
}
