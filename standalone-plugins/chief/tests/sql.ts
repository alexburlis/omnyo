import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { applyMigrations, type Sql } from "../lib/db.ts";

const rowSchema = z.record(z.string(), z.union([z.string(), z.number(), z.bigint(), z.null()]));

export function memorySql(): Sql {
  const driver = new DatabaseSync(":memory:");

  const sql: Sql = {
    exec: (text) => {
      driver.exec(text);
    },
    prepare: (text) => {
      const statement = driver.prepare(text);

      return {
        run: (...params) => {
          statement.run(...params);
        },
        get: (...params) => {
          const row = statement.get(...params);

          return row === undefined ? undefined : rowSchema.parse(row);
        },
        all: (...params) => statement.all(...params).map((row) => rowSchema.parse(row)),
      };
    },
  };

  applyMigrations(sql);

  return sql;
}
