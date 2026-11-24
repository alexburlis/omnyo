import type { PluginApi } from "@omnyo/plugin-sdk";

type ThreadCallback = Awaited<
  ReturnType<PluginApi["sdk"]["experimental_attention"]["snapshot"]>
>["callbacks"][number];

export type CallbackWaitView = ThreadCallback;

export type CallbackWait = Pick<
  ThreadCallback,
  "id" | "threadId" | "sourceThreadId" | "reason" | "createdAt" | "afterSeq"
>;
