import { createConnection } from "../../src/connection.js";
import type {
  DbConnection,
  CreateConnectionOptions,
} from "../../src/connection.js";
import { migrate } from "../../src/migrate.js";

let migratedTemplate: Buffer | null = null;

function getMigratedTemplate(): Buffer {
  if (migratedTemplate === null) {
    const db = createConnection(":memory:");

    try {
      migrate(db);
      migratedTemplate = db.$client.serialize();
    } finally {
      db.$client.close();
    }
  }

  return migratedTemplate;
}

export function prepareMigratedConnectionTemplate(): void {
  getMigratedTemplate();
}

export function createMigratedConnection(
  options: CreateConnectionOptions = {},
): DbConnection {
  return createConnection(getMigratedTemplate(), options);
}
