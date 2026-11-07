import { createServer } from "node:http";

const server = createServer(async (request, response) => {
  response.setHeader("content-type", "application/json");
  if (request.method !== "POST") {
    response.writeHead(405).end(JSON.stringify({ error: "Use POST" }));
    return;
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const reply = (result) => response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
  if (body.method === "initialize") {
    reply({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "local-fixture", version: "1.0.0" } });
  } else if (body.method === "notifications/initialized") {
    response.writeHead(202).end();
  } else if (body.method === "tools/list") {
    reply({ tools: [{
      name: "get_workspace_info",
      description: "Read the local fixture workspace name and whether its private port is reachable.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
    }] });
  } else if (body.method === "tools/call" && body.params?.name === "get_workspace_info") {
    reply({ content: [{ type: "text", text: "LOCAL_MCP_OK: Paper fixture running on 127.0.0.1; cloud inbound access is disabled." }] });
  } else if (body.method === "ping") {
    reply({});
  } else {
    response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Unknown method" } }));
  }
});
server.listen(3750, "127.0.0.1", () => console.log("Local MCP fixture listening on http://127.0.0.1:3750/mcp"));
