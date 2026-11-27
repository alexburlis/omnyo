import { z } from "zod";

const coordinate = z.number().finite().min(-10_000_000).max(10_000_000);

const ordinal = z.number().int().min(1).max(1_000_000_000);

const version = z
  .string()
  .regex(/^\d+\.\d+\.\d+(?:\.\d+)?$/)
  .nullable();

const region = z.object({ top: coordinate, height: coordinate }).strict().nullable();

export const layoutTraceSchema = z
  .object({
    v: z.literal(1),
    session: z.uuid(),
    asset: z
      .string()
      .regex(/^[a-f0-9]{8,64}$/)
      .nullable(),
    platform: z.enum(["electron", "browser"]),
    chromeVersion: version,
    electronVersion: version,
    startedAt: z.number().finite().nonnegative(),
    samples: z
      .array(
        z
          .object({
            at: z.number().finite().nonnegative(),
            reason: z.enum(["hover", "leave", "scroll", "mutation", "unmount"]),
            visibility: z.enum(["visible", "hidden"]),
            target: ordinal.nullable(),
            hit: ordinal.nullable(),
            scrollTop: coordinate,
            list: z.object({ width: coordinate, height: coordinate }).strict(),
            root: region,
            toolbar: region,
            rows: z
              .array(
                z
                  .object({
                    id: ordinal,
                    top: coordinate,
                    left: coordinate,
                    width: coordinate,
                    height: coordinate,
                    offsetTop: coordinate,
                    translate: z.tuple([coordinate, coordinate]),
                    transform: z.tuple([
                      coordinate,
                      coordinate,
                      coordinate,
                      coordinate,
                      coordinate,
                      coordinate,
                    ]),
                    animations: z
                      .array(
                        z
                          .object({
                            state: z.enum(["idle", "running", "paused", "finished"]),
                            time: coordinate.nullable(),
                          })
                          .strict(),
                      )
                      .max(3),
                  })
                  .strict(),
              )
              .max(12),
          })
          .strict(),
      )
      .min(1)
      .max(40),
  })
  .strict();

export type LayoutTrace = z.infer<typeof layoutTraceSchema>;

export const storedLayoutTraceSchema = z
  .object({ receivedAt: z.number(), trace: layoutTraceSchema })
  .strict();
