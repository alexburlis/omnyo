import {
  createConnection,
  ensureCoordinatorStoreId,
  ensurePersonalProject,
  migrate,
} from "@omnyo/db";
import { assertConfiguredOmnyoStateWriteAdmission } from "@omnyo/config/omnyo-state-startup";
import { dirname } from "node:path";
import type {
  DbConnection,
  MigrationWarningLogger,
  SlowDbQueryLogger,
} from "@omnyo/db";
import type { Logger } from "@omnyo/logger";
import {
  exportLegacyAutomationsForPluginImport,
  hasLegacyAutomationsToExport,
} from "./legacy-automations-export.js";

type InitDbLogger = MigrationWarningLogger &
  SlowDbQueryLogger &
  Pick<Logger, "error" | "info">;

interface InitDbOptions {
  dataDir?: string;
  slowQueryThresholdMs?: number | (() => number);
  slowQueryDiagnosticsEnabled?: () => boolean;
  slowQueryWork?: () => string | null;
  logger?: InitDbLogger;
}

export function initDb(
  databasePath: string,
  options: InitDbOptions = {},
): DbConnection {
  if (databasePath !== ":memory:" || options.dataDir !== undefined) {
    assertConfiguredOmnyoStateWriteAdmission(
      options.dataDir ?? dirname(databasePath),
    );
  }

  const db = createConnection(databasePath, {
    backgroundCheckpoint: {
      onError: (error) =>
        options.logger?.error(
          { err: error },
          "Database checkpoint worker failed",
        ),
    },
    slowQueryLogger: options.logger,
    slowQueryThresholdMs: options.slowQueryThresholdMs,
    slowQueryDiagnosticsEnabled: options.slowQueryDiagnosticsEnabled,
    slowQueryWork: options.slowQueryWork,
  });

  try {
    if (options.dataDir !== undefined && options.logger !== undefined) {
      exportLegacyAutomationsForPluginImport({
        dataDir: options.dataDir,
        db,
        logger: options.logger,
      });
    } else if (hasLegacyAutomationsToExport(db)) {
      throw new Error(
        "Cannot migrate legacy automations without dataDir and logger; refusing to drop kernel automation rows before exporting them for the automations plugin",
      );
    }

    migrate(db, { logger: options.logger });
    ensurePersonalProject(db);
    ensureCoordinatorStoreId(db);
  } catch (error) {
    db.$client.close();
    throw error;
  }

  return db;
}
