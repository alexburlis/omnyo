import { expect, it } from "vitest";
import { z } from "zod";

interface AvailabilityMethod {
  input: z.ZodType;
  output: z.ZodType;
  experimental_description?: string;
}

interface AvailabilityContractModule {
  retryAvailabilityMethod: string;
  retryAvailabilityContract: Record<string, AvailabilityMethod>;
}

async function loadContract(
  relativePath: string,
): Promise<AvailabilityContractModule> {
  const loaded: unknown = await import(
    new URL(relativePath, import.meta.url).href
  );

  if (
    typeof loaded !== "object" ||
    loaded === null ||
    !("retryAvailabilityMethod" in loaded) ||
    typeof loaded.retryAvailabilityMethod !== "string" ||
    !("retryAvailabilityContract" in loaded) ||
    typeof loaded.retryAvailabilityContract !== "object"
  )
    throw new Error(`${relativePath} did not expose the availability contract`);

  return loaded as AvailabilityContractModule;
}

function wireShape(module: AvailabilityContractModule) {
  const method =
    module.retryAvailabilityContract[module.retryAvailabilityMethod];

  if (method === undefined)
    throw new Error(`Contract has no ${module.retryAvailabilityMethod} method`);

  return {
    method: module.retryAvailabilityMethod,
    input: z.toJSONSchema(method.input),
    output: z.toJSONSchema(method.output),
    description: method.experimental_description ?? null,
  };
}

it("keeps Account Pooler's copy of the retry availability contract identical to Provider Retry's", async () => {
  const [consumer, producer] = await Promise.all([
    loadContract("../../../../../plugins/provider-retry/src/retry-contract.ts"),
    loadContract("../../../../../plugins/account-pool/src/retry-contract.ts"),
  ]);

  expect(wireShape(producer)).toEqual(wireShape(consumer));
});
