import * as SecureStore from "expo-secure-store";
import { memorySecretStore, type SecretStore } from "../modules/accountSession";

let webStore: SecretStore | null = null;

export async function deviceSecretStore(): Promise<SecretStore> {
  if (await SecureStore.isAvailableAsync()) {
    return {
      persistent: true,
      get: (key) => SecureStore.getItemAsync(key),
      set: (key, value) => SecureStore.setItemAsync(key, value, { keychainAccessible: SecureStore.WHEN_UNLOCKED }),
      remove: (key) => SecureStore.deleteItemAsync(key),
    };
  }
  webStore ??= memorySecretStore();
  return webStore;
}
