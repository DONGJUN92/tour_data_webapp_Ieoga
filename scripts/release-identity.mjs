import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const CANONICAL_DEPLOYMENT_ORIGIN =
  "https://ieoga-national-travel-resilience.sans5-poems-5045.workers.dev";
export const CLOUDFLARE_API_ORIGIN = "https://api.cloudflare.com";
export const CLOUDFLARE_WORKER_NAME = "ieoga-national-travel-resilience";
export const RELEASE_ATTESTATION_REPOSITORY =
  "DONGJUN92/tour_data_webapp_Ieoga";
export const RELEASE_ATTESTATION_WORKFLOW =
  "DONGJUN92/tour_data_webapp_Ieoga/.github/workflows/release-production.yml";
export const RELEASE_ATTESTATION_SOURCE_REF = "refs/heads/main";
export const RELEASE_PREPARED_BUILD_PATH =
  "outputs/release/prepared-build.json";
export const RELEASE_RECEIPT_PATH = "outputs/release/release-receipt.json";
export const RELEASE_BUNDLE_MANIFEST_PATH =
  "outputs/release/worker-bundle-manifest.json";
export const RELEASE_ASSET_MANIFEST_PATH =
  "outputs/release/static-asset-manifest.json";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const COMMIT_SHA_PATTERN = /^[a-f0-9]{40}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const WORKER_VERSION_ID_PATTERN = /^[a-f0-9][a-f0-9-]{15,63}$/i;
const RECEIPT_TYPE = "urn:ieoga:cloudflare-release-receipt:v1";
const PREPARED_TYPE = "urn:ieoga:prepared-worker-build:v1";

function assertCommitSha(value, label = "commit SHA") {
  if (!COMMIT_SHA_PATTERN.test(value ?? "")) {
    throw new Error(`${label} must be a 40-character hexadecimal Git SHA.`);
  }
  return value.toLowerCase();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function compareCanonicalText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** RFC 8785 is intentionally unnecessary here: release objects contain only
 * JSON strings, integers, arrays, and records. Sorting every record key still
 * gives one platform-independent byte representation for hashing and storage.
 */
export function canonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Canonical JSON rejects non-finite numbers.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.keys(value)
      .sort(compareCanonicalText)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  throw new Error("Canonical JSON rejects undefined and unsupported values.");
}

async function filesUnder(directory, base = directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) =>
    compareCanonicalText(left.name, right.name),
  )) {
    const absolutePath = path.resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await filesUnder(absolutePath, base)));
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Release artifacts may not contain links or special files: ${absolutePath}`);
    }
    const bytes = await readFile(absolutePath);
    files.push({
      path: path.relative(base, absolutePath).split(path.sep).join("/"),
      sha256: sha256(bytes),
      size: bytes.byteLength,
    });
  }
  return files;
}

export async function createCanonicalTreeManifest(
  directory,
  logicalRoot,
) {
  const files = (await filesUnder(directory)).sort((left, right) =>
    compareCanonicalText(left.path, right.path),
  );
  if (files.length === 0) {
    throw new Error(`Release artifact tree is empty: ${logicalRoot}`);
  }
  return {
    schemaVersion: 1,
    root: logicalRoot,
    files,
  };
}

function treeDigest(manifest) {
  return sha256(Buffer.from(canonicalJson(manifest), "utf8"));
}

function requiredTreeFiles(bundleManifest, assetManifest) {
  const bundlePaths = new Set(bundleManifest.files.map((entry) => entry.path));
  const assetPaths = new Set(assetManifest.files.map((entry) => entry.path));
  for (const required of ["index.js", "wrangler.json"]) {
    if (!bundlePaths.has(required)) {
      throw new Error(`Production build is missing dist/server/${required}.`);
    }
  }
  for (const required of ["_headers", "sw.js", "manifest.webmanifest"]) {
    if (!assetPaths.has(required)) {
      throw new Error(`Production build is missing dist/client/${required}.`);
    }
  }
}

async function validateGeneratedWranglerConfig(root) {
  const configPath = path.resolve(root, "dist/server/wrangler.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  if (
    config.name !== CLOUDFLARE_WORKER_NAME ||
    config.main !== "index.js" ||
    config.no_bundle !== true ||
    config.version_metadata?.binding !== "CF_VERSION_METADATA" ||
    config.assets?.directory !== "../client"
  ) {
    throw new Error(
      "Generated Wrangler config must retain the canonical worker, no-bundle assets, and CF_VERSION_METADATA binding.",
    );
  }
}

export async function createPreparedBuild({ root = ROOT, commitSha }) {
  const normalizedCommit = assertCommitSha(commitSha);
  const bundleManifest = await createCanonicalTreeManifest(
    path.resolve(root, "dist/server"),
    "dist/server",
  );
  const assetManifest = await createCanonicalTreeManifest(
    path.resolve(root, "dist/client"),
    "dist/client",
  );
  requiredTreeFiles(bundleManifest, assetManifest);
  await validateGeneratedWranglerConfig(root);
  return {
    prepared: {
      schemaVersion: 1,
      type: PREPARED_TYPE,
      commitSha: normalizedCommit,
      bundleDigest: treeDigest(bundleManifest),
      assetManifestDigest: treeDigest(assetManifest),
      bundleManifestPath: RELEASE_BUNDLE_MANIFEST_PATH,
      assetManifestPath: RELEASE_ASSET_MANIFEST_PATH,
      bundleFileCount: bundleManifest.files.length,
      assetFileCount: assetManifest.files.length,
    },
    bundleManifest,
    assetManifest,
  };
}

export function parseWranglerDeployOutput(source) {
  const records = String(source)
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error("Wrangler output must be valid ND-JSON.");
      }
    });
  const deployment = records.findLast((entry) => entry?.type === "deploy");
  if (
    deployment?.version !== 1 ||
    deployment.worker_name !== CLOUDFLARE_WORKER_NAME ||
    !WORKER_VERSION_ID_PATTERN.test(deployment.version_id ?? "") ||
    !Array.isArray(deployment.targets) ||
    deployment.targets.length !== 1 ||
    !deployment.targets.every((target) => {
      try {
        const parsed = new URL(target);
        return (
          parsed.href === `${CANONICAL_DEPLOYMENT_ORIGIN}/` &&
          !parsed.username &&
          !parsed.password
        );
      } catch {
        return false;
      }
    })
  ) {
    throw new Error("Wrangler output does not identify the canonical production deployment.");
  }
  return {
    versionId: deployment.version_id,
    workerName: deployment.worker_name,
  };
}

function cloudflareResult(body) {
  if (!body || body.success !== true || !body.result) {
    throw new Error("Cloudflare control-plane response is not successful.");
  }
  return body.result;
}

function activeDeployment(deploymentsBody) {
  const result = cloudflareResult(deploymentsBody);
  const deployments = Array.isArray(result) ? result : result.deployments;
  const active = Array.isArray(deployments) ? deployments[0] : undefined;
  if (
    !active ||
    !Array.isArray(active.versions) ||
    active.versions.length !== 1 ||
    Number(active.versions[0]?.percentage) !== 100
  ) {
    throw new Error("Production Worker must serve exactly one version at 100% traffic.");
  }
  return active.versions[0];
}

export function verifyRemoteReleaseIdentity({
  commitSha,
  versionId,
  deployed,
  deploymentsBody,
  versionBody,
}) {
  const normalizedCommit = assertCommitSha(commitSha);
  if (
    deployed?.releaseBuild !== true ||
    deployed?.releaseReady !== true ||
    deployed?.source !==
      "CF_VERSION_METADATA+DEPLOYMENT_COMMIT_SHA_ASSERTION" ||
    deployed.commitSha?.toLowerCase() !== normalizedCommit ||
    deployed.versionId !== versionId ||
    deployed.versionTag?.toLowerCase() !== normalizedCommit ||
    !Number.isFinite(Date.parse(deployed.versionTimestamp ?? ""))
  ) {
    throw new Error("Runtime version metadata does not match the prepared release.");
  }

  const traffic = activeDeployment(deploymentsBody);
  if (traffic.version_id !== versionId) {
    throw new Error("The prepared Worker version is not receiving 100% production traffic.");
  }

  const version = cloudflareResult(versionBody);
  const controlPlaneTag =
    version.metadata?.annotations?.["workers/tag"] ??
    version.annotations?.["workers/tag"];
  const controlPlaneTimestamp =
    version.metadata?.created_on ?? version.created_on;
  const scriptEtag = version.resources?.script?.etag;
  if (
    version.id !== versionId ||
    String(controlPlaneTag ?? "").toLowerCase() !== normalizedCommit ||
    !Number.isFinite(Date.parse(controlPlaneTimestamp ?? "")) ||
    Date.parse(controlPlaneTimestamp) !== Date.parse(deployed.versionTimestamp) ||
    typeof scriptEtag !== "string" ||
    scriptEtag.length < 8 ||
    scriptEtag.length > 256
  ) {
    throw new Error("Cloudflare version tag, timestamp, or script ETag is inconsistent.");
  }
  return {
    versionId,
    versionTimestamp: new Date(controlPlaneTimestamp).toISOString(),
    scriptEtag,
    trafficPercentage: 100,
  };
}

export function createReleaseReceipt({ prepared, remote, generatedAt }) {
  validatePreparedBuild(prepared);
  const generatedAtIso = new Date(generatedAt).toISOString();
  if (!Number.isFinite(Date.parse(generatedAtIso))) {
    throw new Error("Receipt generation time is invalid.");
  }
  const receipt = {
    schemaVersion: 1,
    type: RECEIPT_TYPE,
    commitSha: prepared.commitSha,
    bundleDigest: prepared.bundleDigest,
    assetManifestDigest: prepared.assetManifestDigest,
    bundleManifestPath: prepared.bundleManifestPath,
    assetManifestPath: prepared.assetManifestPath,
    versionId: remote.versionId,
    scriptEtag: remote.scriptEtag,
    versionTimestamp: remote.versionTimestamp,
    productionOrigin: CANONICAL_DEPLOYMENT_ORIGIN,
    workerName: CLOUDFLARE_WORKER_NAME,
    trafficPercentage: remote.trafficPercentage,
    generatedAt: generatedAtIso,
  };
  validateReleaseReceipt(receipt);
  return receipt;
}

export function validatePreparedBuild(prepared) {
  if (
    prepared?.schemaVersion !== 1 ||
    prepared?.type !== PREPARED_TYPE ||
    !COMMIT_SHA_PATTERN.test(prepared.commitSha ?? "") ||
    !SHA256_PATTERN.test(prepared.bundleDigest ?? "") ||
    !SHA256_PATTERN.test(prepared.assetManifestDigest ?? "") ||
    prepared.bundleManifestPath !== RELEASE_BUNDLE_MANIFEST_PATH ||
    prepared.assetManifestPath !== RELEASE_ASSET_MANIFEST_PATH ||
    !Number.isInteger(prepared.bundleFileCount) ||
    prepared.bundleFileCount < 1 ||
    !Number.isInteger(prepared.assetFileCount) ||
    prepared.assetFileCount < 1
  ) {
    throw new Error("Prepared build identity is malformed.");
  }
  return prepared;
}

export function validateReleaseReceipt(receipt) {
  if (
    receipt?.schemaVersion !== 1 ||
    receipt?.type !== RECEIPT_TYPE ||
    !COMMIT_SHA_PATTERN.test(receipt.commitSha ?? "") ||
    !SHA256_PATTERN.test(receipt.bundleDigest ?? "") ||
    !SHA256_PATTERN.test(receipt.assetManifestDigest ?? "") ||
    receipt.bundleManifestPath !== RELEASE_BUNDLE_MANIFEST_PATH ||
    receipt.assetManifestPath !== RELEASE_ASSET_MANIFEST_PATH ||
    !WORKER_VERSION_ID_PATTERN.test(receipt.versionId ?? "") ||
    typeof receipt.scriptEtag !== "string" ||
    receipt.scriptEtag.length < 8 ||
    receipt.scriptEtag.length > 256 ||
    !Number.isFinite(Date.parse(receipt.versionTimestamp ?? "")) ||
    receipt.productionOrigin !== CANONICAL_DEPLOYMENT_ORIGIN ||
    receipt.workerName !== CLOUDFLARE_WORKER_NAME ||
    receipt.trafficPercentage !== 100 ||
    !Number.isFinite(Date.parse(receipt.generatedAt ?? "")) ||
    Date.parse(receipt.generatedAt) < Date.parse(receipt.versionTimestamp)
  ) {
    throw new Error("Signed release receipt is malformed or internally inconsistent.");
  }
  return receipt;
}

async function fetchJson(url, headers = {}) {
  const response = await fetch(url, {
    headers: { accept: "application/json", ...headers },
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok || response.redirected) {
    throw new Error(`Release identity endpoint ${new URL(url).pathname} returned HTTP ${response.status}.`);
  }
  return response.json();
}

async function fetchRemoteIdentity(versionId) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const apiToken = process.env.CLOUDFLARE_API_TOKEN?.trim();
  if (!/^[a-f0-9]{32}$/i.test(accountId ?? "") || !apiToken) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required.");
  }
  const basePath = `/client/v4/accounts/${accountId}/workers/scripts/${encodeURIComponent(CLOUDFLARE_WORKER_NAME)}`;
  const authorization = { authorization: `Bearer ${apiToken}` };
  const [deployed, deploymentsBody, versionBody] = await Promise.all([
    fetchJson(`${CANONICAL_DEPLOYMENT_ORIGIN}/api/v1/release/version`),
    fetchJson(`${CLOUDFLARE_API_ORIGIN}${basePath}/deployments`, authorization),
    fetchJson(
      `${CLOUDFLARE_API_ORIGIN}${basePath}/versions/${encodeURIComponent(versionId)}`,
      authorization,
    ),
  ]);
  return { deployed, deploymentsBody, versionBody };
}

async function waitForRemoteIdentity(commitSha, versionId) {
  let lastError;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      const remote = await fetchRemoteIdentity(versionId);
      return verifyRemoteReleaseIdentity({
        commitSha,
        versionId,
        ...remote,
      });
    } catch (error) {
      lastError = error;
      if (attempt < 9) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(15_000, 2_000 * (attempt + 1))));
      }
    }
  }
  throw new Error(
    `Production release identity did not converge: ${lastError instanceof Error ? lastError.message : "unknown failure"}`,
  );
}

function parseArgs(argv) {
  const command = argv[0] ?? "";
  const values = { command };
  for (let index = 1; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) throw new Error(`Unexpected argument: ${key}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}.`);
    values[key.slice(2)] = value;
    index += 1;
  }
  return values;
}

async function writeJson(target, value) {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${canonicalJson(value)}\n`, { encoding: "utf8", flag: "w" });
}

function assertCleanHead(commitSha) {
  const normalizedCommit = assertCommitSha(commitSha);
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: ROOT,
    encoding: "utf8",
  }).trim().toLowerCase();
  if (head !== normalizedCommit) {
    throw new Error(`Build commit ${normalizedCommit} does not match clean HEAD ${head}.`);
  }
  const dirty = execFileSync("git", ["status", "--porcelain"], {
    cwd: ROOT,
    encoding: "utf8",
  }).trim();
  if (dirty) throw new Error("Release builds require a clean Git worktree.");
}

async function prepareCommand(args) {
  if (!args.commit || !args.output || !args["bundle-manifest"] || !args["asset-manifest"]) {
    throw new Error("prepare requires --commit, --output, --bundle-manifest, and --asset-manifest.");
  }
  if (
    args.output !== RELEASE_PREPARED_BUILD_PATH ||
    args["bundle-manifest"] !== RELEASE_BUNDLE_MANIFEST_PATH ||
    args["asset-manifest"] !== RELEASE_ASSET_MANIFEST_PATH
  ) {
    throw new Error("Release identity outputs must use the canonical repository paths.");
  }
  assertCleanHead(args.commit);
  const result = await createPreparedBuild({ root: ROOT, commitSha: args.commit });
  await Promise.all([
    writeJson(path.resolve(ROOT, args.output), result.prepared),
    writeJson(path.resolve(ROOT, args["bundle-manifest"]), result.bundleManifest),
    writeJson(path.resolve(ROOT, args["asset-manifest"]), result.assetManifest),
  ]);
  return result.prepared;
}

async function finalizeCommand(args) {
  if (!args.prepared || !args["wrangler-output"] || !args.output) {
    throw new Error("finalize requires --prepared, --wrangler-output, and --output.");
  }
  if (
    args.prepared !== RELEASE_PREPARED_BUILD_PATH ||
    args.output !== RELEASE_RECEIPT_PATH
  ) {
    throw new Error("Release finalization must use the canonical prepared-build and receipt paths.");
  }
  const prepared = validatePreparedBuild(
    JSON.parse(await readFile(path.resolve(ROOT, args.prepared), "utf8")),
  );
  assertCleanHead(prepared.commitSha);
  const current = await createPreparedBuild({
    root: ROOT,
    commitSha: prepared.commitSha,
  });
  if (
    current.prepared.bundleDigest !== prepared.bundleDigest ||
    current.prepared.assetManifestDigest !== prepared.assetManifestDigest ||
    current.prepared.bundleFileCount !== prepared.bundleFileCount ||
    current.prepared.assetFileCount !== prepared.assetFileCount
  ) {
    throw new Error("Release artifacts changed after their canonical digests were prepared.");
  }
  const wrangler = parseWranglerDeployOutput(
    await readFile(path.resolve(ROOT, args["wrangler-output"]), "utf8"),
  );
  const remote = await waitForRemoteIdentity(
    prepared.commitSha,
    wrangler.versionId,
  );
  const receipt = createReleaseReceipt({
    prepared,
    remote,
    generatedAt: new Date().toISOString(),
  });
  await writeJson(path.resolve(ROOT, args.output), receipt);
  return receipt;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = args.command === "prepare"
    ? await prepareCommand(args)
    : args.command === "finalize"
      ? await finalizeCommand(args)
      : (() => {
          throw new Error("Expected release identity command: prepare or finalize.");
        })();
  console.log(JSON.stringify(result, null, 2));
}

const invokedAsScript = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
  : false;
if (invokedAsScript) {
  main().catch((error) => {
    console.error(
      `RELEASE_IDENTITY_FAILED\n${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
