import type {
  ExperimentalNativeFileClassification,
  ExperimentalNativeFileResolver,
} from "@omnyo/plugin-sdk";
import { getOmnyoDesktopInfo } from "./omnyo-desktop";

export function getNativeFileResolver(): ExperimentalNativeFileResolver | null {
  const desktop = getOmnyoDesktopInfo();

  if (desktop?.resolveNativeFiles === undefined) return null;
  const resolve = desktop.resolveNativeFiles.bind(desktop);

  return {
    async resolve(files) {
      const result: ExperimentalNativeFileClassification[] = [];

      for (let offset = 0; offset < files.length; offset += 64) {
        result.push(...(await resolve(files.slice(offset, offset + 64))));
      }

      return result;
    },
  };
}

export function partitionNativeFiles(
  files: readonly File[],
  classifications: readonly ExperimentalNativeFileClassification[],
) {
  if (files.length !== classifications.length)
    throw new Error("Native file result count changed");
  const directories: string[] = [];
  const regularFiles: File[] = [];
  const paths = new Map<File, string>();
  classifications.forEach((classification, index) => {
    if (classification?.kind === "directory")
      directories.push(classification.path);
    else {
      const file = files[index];
      regularFiles.push(file);

      if (classification?.kind === "file" && classification.path !== undefined)
        paths.set(file, classification.path);
    }
  });

  return { directories, files: regularFiles, paths };
}
