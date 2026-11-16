import Parallel from "parallel-web";
import { Sandbox } from "@vercel/sandbox";

export async function webSearch(input: { objective: string; queries: string[] }): Promise<unknown> {
  if (!process.env.PARALLEL_API_KEY) throw new Error("PARALLEL_API_KEY is not configured.");
  const client = new Parallel({ apiKey: process.env.PARALLEL_API_KEY });
  const response = await client.search({
    objective: input.objective,
    search_queries: input.queries,
    mode: "fast",
  });
  return response.results.slice(0, 8).map((result) => ({
    title: result.title,
    url: result.url,
    excerpts: result.excerpts.map((excerpt) => excerpt.slice(0, 1_500)),
    publishDate: result.publish_date,
  }));
}

export async function computerRun(input: { command: string; args: string[] }): Promise<unknown> {
  const sandbox = await Sandbox.create({
    persistent: false,
    timeout: 90_000,
    networkPolicy: "deny-all",
    resources: { vcpus: 1 },
    tags: { app: "slop-bot", purpose: "bounded-computer-tool" },
  });
  try {
    const result = await sandbox.runCommand({
      cmd: input.command,
      args: input.args,
      timeoutMs: 60_000,
    });
    return {
      exitCode: result.exitCode,
      stdout: (await result.stdout()).slice(0, 16_000),
      stderr: (await result.stderr()).slice(0, 4_000),
      durationMs: result.durationMs,
      sandboxId: sandbox.name,
    };
  } finally {
    await sandbox.stop();
  }
}
