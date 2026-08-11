import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const cloudflareStub = new URL("./cloudflare-workers.stub.mjs", import.meta.url);

function firstFile(candidates) {
  return candidates.find(
    (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
  );
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "next/server") {
    return nextResolve("next/server.js", context);
  }
  if (specifier === "cloudflare:workers") {
    return { url: cloudflareStub.href, shortCircuit: true };
  }

  if (specifier.startsWith("@/")) {
    const requestedPath = path.join(projectRoot, specifier.slice(2));
    const candidates = [
      `${requestedPath}.ts`,
      `${requestedPath}.tsx`,
      path.join(requestedPath, "index.ts"),
      path.join(requestedPath, "index.tsx"),
      requestedPath,
    ];
    const resolvedPath = firstFile(candidates);
    if (!resolvedPath) {
      throw new Error(`Test loader could not resolve project alias: ${specifier}`);
    }
    return { url: pathToFileURL(resolvedPath).href, shortCircuit: true };
  }

  if (
    (specifier.startsWith("./") || specifier.startsWith("../")) &&
    context.parentURL?.startsWith("file:") &&
    !path.extname(specifier)
  ) {
    const requestedPath = fileURLToPath(new URL(specifier, context.parentURL));
    const candidates = [
      `${requestedPath}.ts`,
      `${requestedPath}.tsx`,
      `${requestedPath}.mjs`,
      path.join(requestedPath, "index.ts"),
      path.join(requestedPath, "index.tsx"),
    ];
    const resolvedPath = firstFile(candidates);
    if (resolvedPath) {
      return { url: pathToFileURL(resolvedPath).href, shortCircuit: true };
    }
  }

  return nextResolve(specifier, context);
}
