import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileStore } from "../../db/file-store";

/**
 * The workflow layer resolves its store through the process-wide `getStore()`
 * seam. Bind a disposable FileStore before the workflow module (and therefore
 * `AppLive`) is imported so focused tests can drive the real workflow steps.
 */
export const storeDirectory = await mkdtemp(join(tmpdir(), "slop-workflow-store-"));
export const store = new FileStore(join(storeDirectory, "store.json"));

(globalThis as typeof globalThis & { __slopBotStore?: FileStore }).__slopBotStore = store;
