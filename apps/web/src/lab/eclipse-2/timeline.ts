export const CUT = {
  card1: 0.2,
  shotA: 0.78,
  card2: 1.1,
  shotB: 1.62,
  card3: 1.94,
  shotC: 2.5,
  rackEnd: 3.3,
  diamond: 3.32,
  totality: 3.46,
  copy: 3.78,
  settle: 5.2,
} as const;

export const LEADER_SECONDS = 3600 - CUT.totality;

export function cutVariables() {
  const variables: Record<string, string> = {};

  for (const [name, seconds] of Object.entries(CUT)) {
    variables[`--e2-at-${name}`] = `${seconds}s`;
  }

  return variables;
}
