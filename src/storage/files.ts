import { File, Paths } from "expo-file-system";
import type { TextFileStore } from "../modules/backup";

export const documentFiles: TextFileStore = {
  write(name, contents) {
    const file = new File(Paths.document, name);
    if (!file.exists) file.create();
    file.writeSync(contents);
  },
  read(name) {
    return new File(Paths.document, name).textSync();
  },
};

export function writeCacheFile(name: string, contents: string): string {
  const file = new File(Paths.cache, name);
  if (!file.exists) file.create();
  file.writeSync(contents);
  return file.uri;
}

export function readUri(uri: string): string {
  return new File(uri).textSync();
}

export function documentFileUri(name: string): string | null {
  const file = new File(Paths.document, name);
  return file.exists ? file.uri : null;
}
