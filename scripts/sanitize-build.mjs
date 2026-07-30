import {
  readdir,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const distRoot = path.resolve(root, "dist");
const secretNames = new Set([
  "KTO_SERVICE_KEY",
  "PARTNER_API_KEY",
  "OPS_API_KEY",
  "KAKAO_REST_API_KEY",
]);
const providerUrlNames = new Set([
  "REVERSE_GEOCODE_URL",
  "FORWARD_GEOCODE_URL",
  "ROUTING_BASE_URL",
  "WEATHER_API_URL",
]);
const sensitiveQueryNames =
  /^(?:key|api[-_]?key|access[-_]?key|service[-_]?key|token|secret|auth|authorization|signature)$/i;

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

function parseConfiguredSecrets(text) {
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

function secretValuesFor(name, rawValue) {
  const value = rawValue.trim();
  if (!value) return [];
  if (secretNames.has(name)) {
    return value.length >= 8 ? [value] : [];
  }
  if (!providerUrlNames.has(name)) return [];
  try {
    const url = new URL(value);
    const values = [];
    if (url.username.length >= 4) values.push(decodeURIComponent(url.username));
    if (url.password.length >= 4) values.push(decodeURIComponent(url.password));
    for (const [key, candidate] of url.searchParams) {
      if (sensitiveQueryNames.test(key) && candidate.length >= 8) {
        values.push(candidate);
      }
    }
    if (values.length) values.push(value);
    return values;
  } catch {
    return [];
  }
}

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

console.log("Sanitized build artifacts and verified that configured secrets are absent.");
