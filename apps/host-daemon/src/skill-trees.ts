import type { HostDaemonSkillTree } from "@omnyo/host-daemon-contract";

export type FetchSkillTree = (treeHash: string) => Promise<HostDaemonSkillTree>;
