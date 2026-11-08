import { DesktopBridge } from "./bridge";
import type { DesktopStore } from "./store";

const config = {
  apiUrl: process.env["TEST_API_URL"] ?? "http://localhost:3000",
  token: "local-development",
  deviceId: "test-device-12345",
  servers: [],
};
const fakeStore = {
  read: async () => config,
  update: async (patch: Partial<typeof config>) => Object.assign(config, patch),
} as unknown as DesktopStore;
const bridge = new DesktopBridge(fakeStore);
bridge.onStatus = (status, message) => console.log(`[bridge] ${status}: ${message ?? ""}`);
bridge.start();
console.log("Test bridge polling. Press Ctrl+C to stop.");
