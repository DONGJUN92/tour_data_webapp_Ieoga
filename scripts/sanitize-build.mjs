import {
  readdir,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = process.cwd();
const distRoot = path.resolve(root, "dist");
const secretNames = new Set([
  "KTO_SERVICE_KEY",
  "PARTNER_API_KEY",
  "OPS_API_KEY",
  "KAKAO_REST_API_KEY",
  "KMA_SERVICE_KEY",
  "SESSION_SIGNING_KEY",
  "RELEASE_AUDITOR_API_KEY",
]);
const providerUrlNames = new Set([
  "REVERSE_GEOCODE_URL",
  "FORWARD_GEOCODE_URL",
  "ROUTING_BASE_URL",
  "WEATHER_API_URL",
]);
const sensitiveQueryNames =
  /^(?:key|api[-_]?key|access(?:[-_]?(?:key|token))?|service[-_]?key|subscription[-_]?key|client[-_]?secret|token|secret|auth|authorization|signature|sig)$/i;

function insideDist(target) {
  const relative = path.relative(distRoot, target);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const target = path.resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await filesUnder(target)));
    } else if (entry.isFile()) {
      files.push(target);
    }
  }
  return files;
}

export function parseConfiguredSecrets(text) {
  const values = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(
      /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/,
    );
    if (!match) continue;
    const value = match[2].replace(/^['"]|['"]$/g, "");
    values.push(...secretValuesFor(match[1], value));
  }
  return values;
}

function splitConfiguredUrls(name, rawValue) {
  if (name !== "ROUTING_BASE_URL") return [rawValue];

  const parts = rawValue.split(",");
  const endpoints = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    if (/^https?:\/\//i.test(trimmed) || endpoints.length === 0) {
      endpoints.push(trimmed);
    } else {
      // Preserve valid commas inside one endpoint's query value, such as
      // `annotations=distance,duration`.
      endpoints[endpoints.length - 1] += `,${trimmed}`;
    }
  }
  return endpoints;
}

export function secretValuesFor(name, rawValue) {
  const value = rawValue.trim();
  if (!value) return [];
  if (secretNames.has(name)) {
    return value.length >= 8 ? [value] : [];
  }
  if (!providerUrlNames.has(name)) return [];
  const values = [];
  for (const endpoint of splitConfiguredUrls(name, value)) {
    try {
      const url = new URL(endpoint);
      const endpointSecrets = [];
      if (url.username.length >= 4) {
        endpointSecrets.push(decodeURIComponent(url.username));
      }
      if (url.password.length >= 4) {
        endpointSecrets.push(decodeURIComponent(url.password));
      }
      for (const [key, candidate] of url.searchParams) {
        if (sensitiveQueryNames.test(key) && candidate.length >= 8) {
          endpointSecrets.push(candidate);
        }
      }
      if (endpointSecrets.length) {
        values.push(...endpointSecrets, endpoint);
      }
    } catch {
      // Invalid provider URLs are rejected by runtime configuration. They do
      // not weaken scanning of the remaining valid endpoints.
    }
  }
  if (values.length && value.includes(",")) values.push(value);
  return values;
}

async function sanitizeBuild() {
  const configuredSecrets = new Set();
  for (const name of [...secretNames, ...providerUrlNames]) {
    const value = process.env[name]?.trim();
    for (const secret of secretValuesFor(name, value ?? "")) {
      configuredSecrets.add(secret);
    }
  }
  const rootEntries = await readdir(root, { withFileTypes: true });
  const envNames = rootEntries
    .filter(
      (entry) =>
        entry.isFile() &&
        (entry.name === ".dev.vars" ||
          (entry.name.startsWith(".env") &&
            !entry.name.includes(".example"))),
    )
    .map((entry) => entry.name);
  for (const envName of envNames) {
    const envPath = path.resolve(root, envName);
    for (const secret of parseConfiguredSecrets(
      await readFile(envPath, "utf8"),
    )) {
      configuredSecrets.add(secret);
    }
  }

  const buildFiles = await filesUnder(distRoot);
  for (const file of buildFiles) {
    const name = path.basename(file);
    if (
      name === ".dev.vars" ||
      name === ".env" ||
      name.startsWith(".env.")
    ) {
      if (!insideDist(file)) {
        throw new Error("Refused to sanitize a file outside dist.");
      }
      await rm(file, { force: true });
    }
  }

  for (const file of await filesUnder(distRoot)) {
    const fileStat = await stat(file);
    if (fileStat.size > 20 * 1024 * 1024) continue;
    const content = await readFile(file);
    for (const secret of configuredSecrets) {
      if (content.includes(Buffer.from(secret))) {
        throw new Error(
          `Build secret scan failed in ${path.relative(root, file)}.`,
        );
      }
    }
  }

  console.log(
    "Sanitized build artifacts and verified that configured secrets are absent.",
  );
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entryPath === fileURLToPath(import.meta.url)) {
  await sanitizeBuild();
}
