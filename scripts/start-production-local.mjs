import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const wranglerCli = path.join(
  root,
  "node_modules",
  "wrangler",
  "bin",
  "wrangler.js",
);
const configPath = path.join(root, "dist", "server", "wrangler.json");
const envPath = path.join(root, ".env.local");
const persistencePath = path.join(root, ".wrangler", "state");

if (!existsSync(configPath)) {
  console.error("운영 빌드가 없습니다. 먼저 npm run build를 실행해 주세요.");
  process.exit(1);
}

const args = [
  wranglerCli,
  "dev",
  "--config",
  configPath,
  "--local",
  "--persist-to",
  persistencePath,
  ...(existsSync(envPath) ? ["--env-file", envPath] : []),
  ...process.argv.slice(2),
];

const child = spawn(process.execPath, args, {
  cwd: root,
  env: process.env,
  stdio: "inherit",
  windowsHide: true,
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("error", (error) => {
  console.error("운영 로컬 서버를 시작하지 못했습니다.", error);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
