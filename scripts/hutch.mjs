import { spawn } from "node:child_process";
import { delimiter, join } from "node:path";
import { homedir } from "node:os";

const home = homedir();
const hutchBins = [join(home, ".local", "share", "hutch", "bin"), join(home, ".hutch", "bin")];
const child = spawn("hutch", process.argv.slice(2), {
  cwd: new URL("../apps/desktop", import.meta.url),
  env: { ...process.env, PATH: `${hutchBins.join(delimiter)}${delimiter}${process.env.PATH ?? ""}` },
  stdio: "inherit",
});
child.on("error", (error) => {
  console.error(`Could not launch Hutch: ${error.message}`);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
