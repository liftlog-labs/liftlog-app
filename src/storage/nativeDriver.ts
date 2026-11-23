import * as SQLite from "expo-sqlite";
import type { SqlExecutor } from "./sql";

type SyncDb = {
  execSync(sql: string): void;
  runSync(sql: string, params?: readonly unknown[]): unknown;
  getFirstSync<T>(sql: string, params?: readonly unknown[]): T | null;
  getAllSync<T>(sql: string, params?: readonly unknown[]): T[];
  withTransactionSync(task: () => void): void;
  closeSync(): void;
};

export async function openNativeDatabase(name = "liftlog.db"): Promise<SqlExecutor> {
  const db = (await SQLite.openDatabaseAsync(name)) as unknown as SyncDb;
  db.execSync("PRAGMA foreign_keys = ON");
  let depth = 0;
  let serial = 0;
  return {
    exec(sql) {
      db.execSync(sql);
    },
    run(sql, params = []) {
      db.runSync(sql, params);
    },
    get(sql, params = []) {
      return db.getFirstSync(sql, params) ?? undefined;
    },
    all(sql, params = []) {
      return db.getAllSync(sql, params);
    },
    transaction(work) {
      if (depth > 0) {
        const name = `liftlog_nested_${++serial}`;
        db.execSync(`SAVEPOINT ${name}`);
        depth += 1;
        try {
          const result = work();
          db.execSync(`RELEASE ${name}`);
          return result;
        } catch (error) {
          db.execSync(`ROLLBACK TO ${name}`);
          db.execSync(`RELEASE ${name}`);
          throw error;
        } finally { depth -= 1; }
      }
      let result: unknown;
      db.withTransactionSync(() => {
        depth += 1;
        try { result = work(); } finally { depth -= 1; }
      });
      return result as never;
    },
    close() {
      db.closeSync();
    },
  };
}
