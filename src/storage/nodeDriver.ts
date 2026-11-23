import Database from "better-sqlite3";
import type { SqlExecutor } from "./sql";

export type NodeDatabase = SqlExecutor & { close(): void };

export function openNodeDatabase(filename = ":memory:"): NodeDatabase {
  const db = new Database(filename);
  db.pragma("foreign_keys = ON");
  const executor: NodeDatabase = {
    exec(sql: string) {
      db.exec(sql);
    },
    run(sql: string, params: readonly unknown[] = []) {
      db.prepare(sql).run(...params);
    },
    get<T extends Record<string, unknown>>(sql: string, params: readonly unknown[] = []) {
      return db.prepare(sql).get(...params) as T | undefined;
    },
    all<T extends Record<string, unknown>>(sql: string, params: readonly unknown[] = []) {
      return db.prepare(sql).all(...params) as T[];
    },
    transaction<T>(work: () => T): T {
      return db.transaction(work)();
    },
    close() {
      db.close();
    },
  };
  return executor;
}
