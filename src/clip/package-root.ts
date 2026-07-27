import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

type PackageManifest = {
  readonly name?: unknown;
  readonly version?: unknown;
};

function isPackageManifest(value: unknown): value is PackageManifest {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Find this package in either its source tree or compiled `dist` layout. */
export function findKbPackageRoot(
  startDirectory = import.meta.dir,
  dependencies: {
    readonly exists?: (path: string) => boolean;
    readonly readText?: (path: string) => string;
  } = {},
): string {
  const exists = dependencies.exists ?? existsSync;
  const readText = dependencies.readText ?? ((path: string) => readFileSync(path, "utf8"));
  let directory = resolve(startDirectory);
  for (let depth = 0; depth < 8; depth += 1) {
    const manifestPath = join(directory, "package.json");
    if (exists(manifestPath)) {
      try {
        const parsed: unknown = JSON.parse(readText(manifestPath));
        if (
          isPackageManifest(parsed)
          && typeof parsed.name === "string"
          && parsed.name.endsWith("/kb")
          && typeof parsed.version === "string"
        ) return directory;
      } catch {
        // A malformed or unrelated ancestor is not this package root.
      }
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error("Could not locate the kb package root.");
}

/** Resolve a declared runtime dependency without assuming node_modules layout. */
export function resolvePackageDirectory(
  packageName: string,
  parentUrl = import.meta.url,
): string {
  const manifest = createRequire(parentUrl).resolve(`${packageName}/package.json`);
  return dirname(manifest);
}
