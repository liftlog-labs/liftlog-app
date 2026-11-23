import { Directory, File } from "expo-file-system";
import * as SQLite from "expo-sqlite";

export function sqliteDatabaseExists(name: string): boolean {
  try {
    const directory = new Directory(String(SQLite.defaultDatabaseDirectory));
    return new File(directory, name).exists;
  } catch {
    return false;
  }
}
