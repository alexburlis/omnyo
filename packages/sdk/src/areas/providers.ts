import type {
  SystemExecutionOptionsResponse,
  SystemProviderInfo,
  SystemProviderCatalogEntry,
  SystemProvidersQuery,
  SystemClaudeProfilesRequest,
  SystemClaudeProfilesResult,
} from "@omnyo/server-contract";
import {
  readExecutionOptions,
  signalRequestArgs,
  type CreateSdkAreaArgs,
} from "./common.js";

export type ProviderHostRoutingArgs =
  | { environmentId: string; hostId?: never }
  | { environmentId?: never; hostId: string }
  | { environmentId?: never; hostId?: never };

export type ProviderListArgs = ProviderHostRoutingArgs & {
  capability?: SystemProvidersQuery["capability"];
  signal?: AbortSignal;
};

export type ProviderModelsArgs = ProviderHostRoutingArgs & {
  providerId?: string;
  claudeProfileId?: string;
  signal?: AbortSignal;
};

export type ProviderListResult = SystemProviderInfo[];

export type ProviderModelsResult = SystemExecutionOptionsResponse;

export interface ProvidersArea {
  claudeProfiles: ClaudeProfilesArea;
  catalog(): Promise<SystemProviderCatalogEntry[]>;
  setEnabled(args: {
    providerId: string;
    enabled: boolean;
  }): Promise<SystemProviderCatalogEntry[]>;
  list(args?: ProviderListArgs): Promise<ProviderListResult>;
  models(args?: ProviderModelsArgs): Promise<ProviderModelsResult>;
}

type ClaudeProfilesArgs<Action extends SystemClaudeProfilesRequest["action"]> =
  Omit<Extract<SystemClaudeProfilesRequest, { action: Action }>, "action">;

type ClaudeProfilesResult<
  Action extends SystemClaudeProfilesRequest["action"],
> = Extract<SystemClaudeProfilesResult, { action: Action }>;

type ClaudeProfileLoginResult = Extract<
  SystemClaudeProfilesResult,
  { loginState: string }
>;

function hasAction<Action extends SystemClaudeProfilesRequest["action"]>(
  result: SystemClaudeProfilesResult,
  action: Action,
): result is ClaudeProfilesResult<Action> {
  return result.action === action;
}

export interface ClaudeProfilesArea {
  list(args: ClaudeProfilesArgs<"list">): Promise<ClaudeProfilesResult<"list">>;
  add(args: ClaudeProfilesArgs<"add">): Promise<ClaudeProfilesResult<"add">>;
  remove(
    args: ClaudeProfilesArgs<"remove">,
  ): Promise<ClaudeProfilesResult<"remove">>;
  status(
    args: ClaudeProfilesArgs<"status">,
  ): Promise<ClaudeProfilesResult<"status">>;
  usage(
    args: ClaudeProfilesArgs<"usage">,
  ): Promise<ClaudeProfilesResult<"usage">>;
  loginStart(
    args: ClaudeProfilesArgs<"loginStart">,
  ): Promise<ClaudeProfileLoginResult>;
  loginGet(
    args: ClaudeProfilesArgs<"loginGet">,
  ): Promise<ClaudeProfileLoginResult>;
  loginCancel(
    args: ClaudeProfilesArgs<"loginCancel">,
  ): Promise<ClaudeProfileLoginResult>;
  defaultsSet(
    args: ClaudeProfilesArgs<"defaultsSet">,
  ): Promise<ClaudeProfilesResult<"defaultsSet">>;
  pilotSet(
    args: ClaudeProfilesArgs<"pilotSet">,
  ): Promise<ClaudeProfilesResult<"pilotSet">>;
}

export function createProvidersArea(args: CreateSdkAreaArgs): ProvidersArea {
  const { transport } = args;

  async function manage(request: SystemClaudeProfilesRequest) {
    return transport.readJson(
      transport.api.v1.system.providers["claude-profiles"].$post({
        json: request,
      }),
    );
  }

  async function resultFor<
    Action extends SystemClaudeProfilesRequest["action"],
  >(
    action: Action,
    request: SystemClaudeProfilesRequest,
  ): Promise<ClaudeProfilesResult<Action>> {
    const result = await manage(request);

    if (!hasAction(result, action))
      throw new Error("Claude profile response does not match the request.");

    return result;
  }

  return {
    claudeProfiles: {
      list: (input) => resultFor("list", { action: "list", ...input }),
      add: (input) => resultFor("add", { action: "add", ...input }),
      remove: (input) => resultFor("remove", { action: "remove", ...input }),
      status: (input) => resultFor("status", { action: "status", ...input }),
      usage: (input) => resultFor("usage", { action: "usage", ...input }),
      loginStart: async (input) => {
        const result = await manage({ action: "loginStart", ...input });

        if (!("loginState" in result))
          throw new Error(
            "Claude profile login response is missing its state.",
          );

        return result;
      },
      loginGet: async (input) => {
        const result = await manage({ action: "loginGet", ...input });

        if (!("loginState" in result))
          throw new Error(
            "Claude profile login response is missing its state.",
          );

        return result;
      },
      loginCancel: async (input) => {
        const result = await manage({ action: "loginCancel", ...input });

        if (!("loginState" in result))
          throw new Error(
            "Claude profile login response is missing its state.",
          );

        return result;
      },
      defaultsSet: (input) =>
        resultFor("defaultsSet", { action: "defaultsSet", ...input }),
      pilotSet: (input) =>
        resultFor("pilotSet", { action: "pilotSet", ...input }),
    },
    async catalog() {
      return transport.readJson(
        transport.api.v1.system.providers.catalog.$get(),
      );
    },
    async setEnabled(input) {
      return transport.readJson(
        transport.api.v1.system.providers[":id"].enabled.$put({
          param: { id: input.providerId },
          json: { enabled: input.enabled },
        }),
      );
    },
    async list(input = {}) {
      return transport.readJson(
        transport.api.v1.system.providers.$get(
          {
            query: {
              capability: input.capability,
              environmentId: input.environmentId,
              hostId: input.hostId,
            },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async models(input = {}) {
      return readExecutionOptions(transport, input);
    },
  };
}
