import { defineRpcContract, type PluginApi } from "@omnyo/plugin-sdk";
import { z } from "zod";
import {
  ANNOTATION_MENTION_PROVIDER_ID,
  annotationRecordSchema,
  annotationUpdateSchema,
  formatAnnotationContext,
} from "./annotations.js";

const STORAGE_PREFIX = "annotation:";

const REVISION_PREFIX = "revision:";

export const agentAnnotationsRpcContract = defineRpcContract({
  readRevisions: {
    input: z
      .object({ ids: z.array(z.string().min(1).max(64)).max(24) })
      .strict(),
    output: z
      .array(
        z.object({ id: z.string(), record: annotationRecordSchema }).strict(),
      )
      .max(24),
  },
  saveRevision: {
    input: annotationRecordSchema,
    output: z.object({ id: z.string() }).strict(),
  },
  revise: {
    input: annotationUpdateSchema,
    output: z.object({ id: z.string() }).strict(),
  },
  update: {
    input: annotationUpdateSchema,
    output: z.object({ id: z.string() }).strict(),
  },
  save: {
    input: annotationRecordSchema,
    output: z.object({ id: z.string() }).strict(),
  },
});

export default async function plugin(api: PluginApi) {
  api.rpc.register(agentAnnotationsRpcContract, {
    async readRevisions({ ids }) {
      return Promise.all(
        ids.map(async (id) => ({
          id,
          record: annotationRecordSchema.parse(
            await api.storage.kv.get(`${REVISION_PREFIX}${id}`),
          ),
        })),
      );
    },
    async saveRevision(record) {
      const id = crypto.randomUUID();
      await api.storage.kv.set(`${REVISION_PREFIX}${id}`, record);

      return { id };
    },
    async revise({ id, comment }) {
      const record = annotationRecordSchema.parse(
        await api.storage.kv.get(`${REVISION_PREFIX}${id}`),
      );

      const revisionId = crypto.randomUUID();
      await api.storage.kv.set(`${REVISION_PREFIX}${revisionId}`, {
        ...record,
        comment,
      });

      return { id: revisionId };
    },
    async update({ id, comment }) {
      const record = annotationRecordSchema.parse(
        await api.storage.kv.get(`${STORAGE_PREFIX}${id}`),
      );

      await api.storage.kv.set(`${STORAGE_PREFIX}${id}`, {
        ...record,
        comment,
      });

      return { id };
    },
    async save(annotation) {
      const id = annotation.id;
      await api.storage.kv.set(`${STORAGE_PREFIX}${id}`, annotation);

      return { id };
    },
  });
  api.ui.registerMentionProvider({
    id: ANNOTATION_MENTION_PROVIDER_ID,
    label: "Browser annotations",
    search: () => [],
    async resolve(id) {
      const parsed = annotationRecordSchema.safeParse(
        (await api.storage.kv.get(`${REVISION_PREFIX}${id}`)) ??
          (await api.storage.kv.get(`${STORAGE_PREFIX}${id}`)),
      );

      if (!parsed.success) {
        throw new Error("This browser annotation is no longer available");
      }

      return { context: formatAnnotationContext(parsed.data) };
    },
  });
}
