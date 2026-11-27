import { randomUUID } from "node:crypto";
import {
  librarySchema,
  type Collection,
  type Library,
  type LibraryLink,
  type LibraryOperation,
  type SavedPrompt,
} from "./library-contract.ts";

export function emptyLibrary(): Library {
  return { revision: 0, collections: [], links: [], prompts: [] };
}

function find<T extends { id: string }>(items: readonly T[], id: string, label: string): T {
  const found = items.find((item) => item.id === id);

  if (!found) throw new Error(label + " no longer exists.");

  return found;
}

function parentExists(collections: readonly Collection[], parentId: string | null) {
  if (parentId !== null) find(collections, parentId, "Parent collection");
}

export function collectionTreeIds(collections: readonly Collection[], root: string): Set<string> {
  find(collections, root, "Collection");
  const children = new Map<string, string[]>();

  for (const collection of collections) {
    if (collection.parentId === null) continue;
    const siblings = children.get(collection.parentId) ?? [];
    siblings.push(collection.id);
    children.set(collection.parentId, siblings);
  }

  const pending = [root];
  const result = new Set<string>();

  for (const id of pending) {
    if (result.has(id)) throw new Error("Collection hierarchy contains a cycle.");
    result.add(id);
    pending.push(...(children.get(id) ?? []));
  }

  return result;
}

function moveInOrder<T extends { id: string }>(
  items: T[],
  item: T,
  siblings: (candidate: T) => boolean,
  beforeId: string | undefined,
) {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  const previous = items[index];

  if (!previous) throw new Error("The item is missing.");

  if (beforeId === item.id) {
    if (!siblings(previous)) throw new Error("Choose an item in the destination.");

    return;
  }

  items.splice(index, 1);

  if (beforeId === undefined) {
    items.push(item);

    return;
  }

  const before = items.findIndex((candidate) => candidate.id === beforeId && siblings(candidate));

  if (before < 0) throw new Error("The item to move before is no longer in the destination.");
  items.splice(before, 0, item);
}

export function applyLibraryOperation(current: Library, operation: LibraryOperation): Library {
  const collections = [...current.collections];
  const links = [...current.links];
  const prompts = [...current.prompts];

  switch (operation.kind) {
    case "collection.create": {
      parentExists(collections, operation.parentId);
      collections.push({
        id: randomUUID(),
        parentId: operation.parentId,
        title: operation.title,
        description: operation.description,
      });
      break;
    }

    case "collection.update": {
      const old = find(collections, operation.id, "Collection");
      collections[collections.indexOf(old)] = {
        ...old,
        title: operation.title,
        description: operation.description,
      };
      break;
    }

    case "collection.move": {
      const old = find(collections, operation.id, "Collection");
      parentExists(collections, operation.parentId);

      if (
        operation.parentId !== null &&
        collectionTreeIds(collections, old.id).has(operation.parentId)
      )
        throw new Error("A collection cannot be placed within itself.");
      moveInOrder(
        collections,
        { ...old, parentId: operation.parentId },
        (item) => item.parentId === operation.parentId,
        operation.beforeId,
      );
      break;
    }

    case "collection.remove": {
      const removed = collectionTreeIds(collections, operation.id);

      return librarySchema.parse({
        revision: current.revision + 1,
        collections: collections.filter((item) => !removed.has(item.id)),
        links: links.filter((item) => !removed.has(item.collectionId)),
        prompts,
      });
    }

    case "link.add": {
      find(collections, operation.collectionId, "Collection");

      if (operation.target.kind === "prompt") find(prompts, operation.target.promptId, "Prompt");

      if (operation.role === "entry" && operation.target.kind !== "skill")
        throw new Error("Choose a skill as the collection entry point.");
      const { collectionId, target, title, role } = operation;
      links.push({ id: randomUUID(), collectionId, target, title, role });
      break;
    }

    case "link.update": {
      const old = find(links, operation.id, "Library link");
      links[links.indexOf(old)] = { ...old, title: operation.title ?? undefined };
      break;
    }

    case "link.move": {
      const old = find(links, operation.id, "Library link");
      find(collections, operation.collectionId, "Collection");
      moveInOrder(
        links,
        { ...old, collectionId: operation.collectionId },
        (item) => item.collectionId === operation.collectionId,
        operation.beforeId,
      );
      break;
    }

    case "link.remove": {
      links.splice(links.indexOf(find(links, operation.id, "Library link")), 1);
      break;
    }

    case "prompt.create": {
      const { title, body, skillId } = operation;
      prompts.push({ id: randomUUID(), title, body, skillId });
      break;
    }

    case "prompt.update": {
      const old = find(prompts, operation.id, "Prompt");
      const { id, title, body, skillId } = operation;
      prompts[prompts.indexOf(old)] = { id, title, body, skillId };
      break;
    }

    case "prompt.remove": {
      prompts.splice(prompts.indexOf(find(prompts, operation.id, "Prompt")), 1);

      return librarySchema.parse({
        revision: current.revision + 1,
        collections,
        prompts,
        links: links.filter(
          (item) => item.target.kind !== "prompt" || item.target.promptId !== operation.id,
        ),
      });
    }
  }

  return librarySchema.parse({ revision: current.revision + 1, collections, links, prompts });
}

export function appendImportedCollection(
  current: Library,
  items: { collections: Collection[]; links: LibraryLink[]; prompts: SavedPrompt[] },
): Library {
  return librarySchema.parse({
    revision: current.revision + 1,
    collections: [...current.collections, ...items.collections],
    links: [...current.links, ...items.links],
    prompts: [...current.prompts, ...items.prompts],
  });
}
