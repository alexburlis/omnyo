export const CONTROL_HOVER_TRANSITION = "transition-colors duration-150 hover:duration-0";

export const LIST_HOVER_TRANSITION = "transition-none";

export const DISCLOSURE_CHEVRON_TRANSITION =
  "transition-transform duration-(--motion-duration-base) ease-(--motion-ease-smooth) motion-reduce:transition-none";

export function getDisclosureRevealClass(expanded: boolean): string {
  const base =
    "grid transition-[grid-template-rows,opacity] ease-(--motion-ease-smooth) motion-reduce:transition-[opacity] motion-reduce:duration-(--motion-duration-fast)";

  return expanded
    ? `${base} grid-rows-[1fr] opacity-100 duration-(--motion-duration-slow)`
    : `${base} pointer-events-none grid-rows-[0fr] opacity-0 duration-(--motion-duration-base)`;
}
