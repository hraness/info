import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const packageName = "@hraness/kb";
const importSpecifiers = ["@hraness/kb","@hraness/kb/agent-context","@hraness/kb/agent-guide-audit","@hraness/kb/authoring","@hraness/kb/browser-profiles","@hraness/kb/capture","@hraness/kb/cli","@hraness/kb/clip/acquire","@hraness/kb/clip/args","@hraness/kb/clip/bounded-byte-buffer","@hraness/kb/clip/cli","@hraness/kb/clip/cookies","@hraness/kb/clip/doctor","@hraness/kb/clip/network","@hraness/kb/clip/network-proxy","@hraness/kb/clip/persist","@hraness/kb/clip/terminal","@hraness/kb/graph","@hraness/kb/navigation","@hraness/kb/pdf","@hraness/kb/percolate","@hraness/kb/query","@hraness/kb/semantic"];
const binNames = ["kb"];
const verificationPackages = ["@types/bun@^1.3.14","fast-check@^4.8.0","typescript@^6.0.3"];

async function run(command: string[], cwd: string): Promise<void> {
  const process = Bun.spawn(command, { cwd, stdout: "inherit", stderr: "inherit" });
  const exitCode = await process.exited;
  if (exitCode !== 0) throw new Error(`Command failed (${String(exitCode)}): ${command.join(" ")}`);
}

const repository = process.cwd();
const work = await mkdtemp(join(tmpdir(), "hraness-package-smoke-"));
try {
  const archive = join(work, "package.tgz");
  const consumer = join(work, "consumer");
  await mkdir(consumer);
  await run([
    process.execPath,
    "pm",
    "pack",
    "--filename",
    archive,
    "--ignore-scripts",
    "--quiet",
  ], repository);
  await writeFile(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
  await run([process.execPath, "add", archive, "--ignore-scripts"], consumer);
  await run(["node", "--input-type=module", "-e", `await import(${JSON.stringify(packageName)})`], consumer);
  for (const binName of binNames) {
    await run([join(consumer, "node_modules", ".bin", binName), "--help"], consumer);
  }
  if (verificationPackages.length > 0) {
    await run([process.execPath, "add", ...verificationPackages, "--ignore-scripts"], consumer);
  }
  await run([
    "node",
    "--input-type=module",
    "-e",
    `await Promise.all(${JSON.stringify(importSpecifiers)}.map((specifier) => import(specifier)))`,
  ], consumer);
  await writeFile(join(consumer, "index.ts"), "import * as surface0 from \"@hraness/kb\";\nimport * as surface1 from \"@hraness/kb/agent-context\";\nimport * as surface2 from \"@hraness/kb/agent-guide-audit\";\nimport * as surface3 from \"@hraness/kb/authoring\";\nimport * as surface4 from \"@hraness/kb/browser-profiles\";\nimport * as surface5 from \"@hraness/kb/capture\";\nimport * as surface6 from \"@hraness/kb/cli\";\nimport * as surface7 from \"@hraness/kb/clip/acquire\";\nimport * as surface8 from \"@hraness/kb/clip/args\";\nimport * as surface9 from \"@hraness/kb/clip/bounded-byte-buffer\";\nimport * as surface10 from \"@hraness/kb/clip/cli\";\nimport * as surface11 from \"@hraness/kb/clip/cookies\";\nimport * as surface12 from \"@hraness/kb/clip/doctor\";\nimport * as surface13 from \"@hraness/kb/clip/network\";\nimport * as surface14 from \"@hraness/kb/clip/network-proxy\";\nimport * as surface15 from \"@hraness/kb/clip/persist\";\nimport * as surface16 from \"@hraness/kb/clip/terminal\";\nimport * as surface17 from \"@hraness/kb/graph\";\nimport * as surface18 from \"@hraness/kb/navigation\";\nimport * as surface19 from \"@hraness/kb/pdf\";\nimport * as surface20 from \"@hraness/kb/percolate\";\nimport * as surface21 from \"@hraness/kb/query\";\nimport * as surface22 from \"@hraness/kb/semantic\";\nvoid [surface0, surface1, surface2, surface3, surface4, surface5, surface6, surface7, surface8, surface9, surface10, surface11, surface12, surface13, surface14, surface15, surface16, surface17, surface18, surface19, surface20, surface21, surface22];\n");
  await writeFile(join(consumer, "tsconfig.bundler.json"), "{\n  \"compilerOptions\": {\n    \"target\": \"ES2023\",\n    \"lib\": [\n      \"ES2023\",\n      \"DOM\",\n      \"DOM.Iterable\"\n    ],\n    \"types\": [\n      \"bun\",\n      \"node\"\n    ],\n    \"strict\": true,\n    \"noEmit\": true,\n    \"skipLibCheck\": false,\n    \"module\": \"Preserve\",\n    \"moduleResolution\": \"Bundler\"\n  },\n  \"include\": [\n    \"index.ts\"\n  ]\n}");
  await run([process.execPath, "x", "tsc", "-p", "./tsconfig.bundler.json"], consumer);

} finally {
  await rm(work, { recursive: true, force: true });
}
