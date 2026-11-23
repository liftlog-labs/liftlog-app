export interface SqlExecutor {
  exec(sql: string): void;
  run(sql: string, params?: readonly unknown[]): void;
  get<T extends Record<string, unknown>>(sql: string, params?: readonly unknown[]): T | undefined;
  all<T extends Record<string, unknown>>(sql: string, params?: readonly unknown[]): T[];
  transaction<T>(work: () => T): T;
  close(): void;
}
