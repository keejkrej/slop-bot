import { FileStore } from "./file-store";
import { PostgresStore } from "./postgres-store";
import type { AppStore } from "./types";

const globalStore = globalThis as typeof globalThis & { __slopBotStore?: AppStore };

export function getStore(): AppStore {
  if (!globalStore.__slopBotStore) {
    globalStore.__slopBotStore = process.env.DATABASE_URL
      ? new PostgresStore(process.env.DATABASE_URL)
      : new FileStore();
  }
  return globalStore.__slopBotStore;
}
