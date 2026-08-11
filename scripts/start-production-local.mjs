import { spawn, spawnSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPlaywrightD1FixtureSql } from "./playwright-d1-fixture.mjs";

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
const isPlaywrightServer = process.env.IEOGA_PLAYWRIGHT_SERVER === "true";
// Browser tests must not contend with a developer server or inherit stale D1
// locks. A process-scoped state directory keeps workerd deterministic while
// the normal local server continues to reuse its durable development state.
const persistencePath = isPlaywrightServer
  ? path.join(root, ".wrangler", `playwright-${process.pid}`)
  : path.join(root, ".wrangler", "state");
const testSessionSigningKey = isPlaywrightServer
  ? process.env.SESSION_SIGNING_KEY?.trim()
  : undefined;
const testEmbedAllowedOrigins = isPlaywrightServer
  ? process.env.EMBED_ALLOWED_ORIGINS?.trim()
  : undefined;
const testDeploymentCommitSha = isPlaywrightServer
  ? process.env.DEPLOYMENT_COMMIT_SHA?.trim()
  : undefined;

if (
  isPlaywrightServer &&
  (!testSessionSigningKey || Buffer.byteLength(testSessionSigningKey) !== 32)
) {
  console.error(
    "브라우저 검증 서버에는 정확히 32바이트인 전용 세션 서명키가 필요합니다.",
  );
  process.exit(1);
}

if (!existsSync(configPath)) {
  console.error("운영 빌드가 없습니다. 먼저 npm run build를 실행해 주세요.");
  process.exit(1);
}

if (isPlaywrightServer) {
  /* Browser integration tests exercise the real API routes and D1 transaction
     boundaries. A fresh per-process database without migrations would make
     every request fail in the rate limiter before reaching the contract under
     test, which is a false green when the browser layer mocks the response. */
  const migration = spawnSync(
    process.execPath,
    [
      wranglerCli,
      "d1",
      "migrations",
      "apply",
      "site-creator-d1",
      "--local",
      "--persist-to",
      persistencePath,
      "--config",
      configPath,
    ],
    {
      cwd: root,
      env: process.env,
      encoding: "utf8",
      windowsHide: true,
    },
  );
  if (migration.status !== 0) {
    rmSync(persistencePath, { recursive: true, force: true });
    console.error(
      "브라우저 통합 검증용 D1 마이그레이션에 실패했습니다.",
      migration.stderr || migration.stdout,
    );
    process.exit(1);
  }

  /* Seed only the isolated Playwright database after its real migrations have
     completed. This is a startup harness, never an HTTP route or Worker
     binding, so no deployed caller can manufacture authoritative runs. */
  const seedFilePath = path.join(
    persistencePath,
    "playwright-contract-fixture.sql",
  );
  try {
    writeFileSync(
      seedFilePath,
      buildPlaywrightD1FixtureSql({
        signingKey: testSessionSigningKey,
      }),
      { encoding: "utf8", flag: "wx" },
    );
    const seed = spawnSync(
      process.execPath,
      [
        wranglerCli,
        "d1",
        "execute",
        "site-creator-d1",
        "--local",
        "--persist-to",
        persistencePath,
        "--config",
        configPath,
        "--file",
        seedFilePath,
        "--yes",
      ],
      {
        cwd: root,
        env: process.env,
        encoding: "utf8",
        windowsHide: true,
      },
    );
    if (seed.status !== 0) {
      throw new Error(seed.stderr || seed.stdout || "D1 fixture seed failed.");
    }
  } catch (error) {
    rmSync(seedFilePath, { force: true });
    rmSync(persistencePath, { recursive: true, force: true });
    console.error(
      "Playwright contract fixture could not be seeded into local D1.",
      error,
    );
    process.exit(1);
  }
  rmSync(seedFilePath, { force: true });
}

const args = [
  wranglerCli,
  "dev",
  "--config",
  configPath,
  "--local",
  "--persist-to",
  persistencePath,
  // E2E is hermetic: never load a developer's real keys, and avoid the
  // Wrangler Windows deadlock observed when --env-file and --var are combined.
  ...(!isPlaywrightServer && existsSync(envPath)
    ? ["--env-file", envPath]
    : []),
  ...(testSessionSigningKey
    ? ["--var", `SESSION_SIGNING_KEY:${testSessionSigningKey}`]
    : []),
  ...(testEmbedAllowedOrigins
    ? ["--var", `EMBED_ALLOWED_ORIGINS:${testEmbedAllowedOrigins}`]
    : []),
  ...(testDeploymentCommitSha
    ? ["--var", `DEPLOYMENT_COMMIT_SHA:${testDeploymentCommitSha}`]
    : []),
  ...process.argv.slice(2),
];
const childEnv = { ...process.env };
if (isPlaywrightServer) {
  // The key has already been converted to a Worker binding above. Keeping the
  // same name in Wrangler's process environment as well as --var deadlocks
  // workerd on Windows, so do not forward either test-control variable.
  delete childEnv.SESSION_SIGNING_KEY;
  delete childEnv.IEOGA_PLAYWRIGHT_SERVER;
  delete childEnv.EMBED_ALLOWED_ORIGINS;
  delete childEnv.DEPLOYMENT_COMMIT_SHA;
}

const child = spawn(process.execPath, args, {
  cwd: root,
  env: childEnv,
  stdio: "inherit",
  windowsHide: true,
});

function cleanupPlaywrightState() {
  if (!isPlaywrightServer) return;
  const expectedParent = path.resolve(root, ".wrangler");
  const resolved = path.resolve(persistencePath);
  if (
    path.dirname(resolved) === expectedParent &&
    path.basename(resolved) === `playwright-${process.pid}`
  ) {
    rmSync(resolved, { recursive: true, force: true });
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("error", (error) => {
  cleanupPlaywrightState();
  console.error("운영 로컬 서버를 시작하지 못했습니다.", error);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  cleanupPlaywrightState();
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
