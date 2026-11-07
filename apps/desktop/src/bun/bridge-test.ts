import { DesktopBridge } from "./bridge";
import type { DesktopStore } from "./store";

const integrationId = process.env["TEST_INTEGRATION_ID"];
if (!integrationId) throw new Error("TEST_INTEGRATION_ID is required.");
const config = {
  apiUrl: "http://localhost:3000",
  token: "local-development",
  deviceId: "test-device-12345",
  servers: [{
    localId: "test-local-server-12345",
    integrationId,
    name: "Paper fixture",
    url: "http://127.0.0.1:3750/mcp",
    status: "connected" as const,
    tools: [{ name: "get_workspace_info", description: "Read local fixture state", inputSchema: { type: "object" }, readOnly: true }],
  }],
};
const fakeStore = {
  read: async () => config,
  update: async (patch: Partial<typeof config>) => Object.assign(config, patch),
} as unknown as DesktopStore;
const bridge = new DesktopBridge(fakeStore);
bridge.onStatus = (status, message) => console.log(`[bridge] ${status}: ${message ?? ""}`);
bridge.start();
console.log("Test bridge polling. Press Ctrl+C to stop.");
