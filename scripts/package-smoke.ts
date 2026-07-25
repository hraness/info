import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const packageName = "@hraness/oh";
const importSpecifiers = ["@hraness/oh","@hraness/oh/agent-context","@hraness/oh/agent-guide-audit","@hraness/oh/browser-profiles","@hraness/oh/capture","@hraness/oh/clip/acquire","@hraness/oh/clip/args","@hraness/oh/clip/bounded-byte-buffer","@hraness/oh/clip/cli","@hraness/oh/clip/cookies","@hraness/oh/clip/doctor","@hraness/oh/clip/network","@hraness/oh/clip/network-proxy","@hraness/oh/clip/persist","@hraness/oh/clip/terminal","@hraness/oh/graph","@hraness/oh/navigation","@hraness/oh/pdf","@hraness/oh/query","@hraness/oh/semantic"];
const binNames = ["oh"];
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
  await writeFile(join(consumer, "index.ts"), "import * as surface0 from \"@hraness/oh\";\nimport * as surface1 from \"@hraness/oh/agent-context\";\nimport * as surface2 from \"@hraness/oh/agent-guide-audit\";\nimport * as surface3 from \"@hraness/oh/browser-profiles\";\nimport * as surface4 from \"@hraness/oh/capture\";\nimport * as surface5 from \"@hraness/oh/clip/acquire\";\nimport * as surface6 from \"@hraness/oh/clip/args\";\nimport * as surface7 from \"@hraness/oh/clip/bounded-byte-buffer\";\nimport * as surface8 from \"@hraness/oh/clip/cli\";\nimport * as surface9 from \"@hraness/oh/clip/cookies\";\nimport * as surface10 from \"@hraness/oh/clip/doctor\";\nimport * as surface11 from \"@hraness/oh/clip/network\";\nimport * as surface12 from \"@hraness/oh/clip/network-proxy\";\nimport * as surface13 from \"@hraness/oh/clip/persist\";\nimport * as surface14 from \"@hraness/oh/clip/terminal\";\nimport * as surface15 from \"@hraness/oh/graph\";\nimport * as surface16 from \"@hraness/oh/navigation\";\nimport * as surface17 from \"@hraness/oh/pdf\";\nimport * as surface18 from \"@hraness/oh/query\";\nimport * as surface19 from \"@hraness/oh/semantic\";\nvoid [surface0, surface1, surface2, surface3, surface4, surface5, surface6, surface7, surface8, surface9, surface10, surface11, surface12, surface13, surface14, surface15, surface16, surface17, surface18, surface19];\n");
  await writeFile(join(consumer, "tsconfig.bundler.json"), "{\n  \"compilerOptions\": {\n    \"target\": \"ES2023\",\n    \"lib\": [\n      \"ES2023\",\n      \"DOM\",\n      \"DOM.Iterable\"\n    ],\n    \"types\": [\n      \"bun\",\n      \"node\"\n    ],\n    \"strict\": true,\n    \"noEmit\": true,\n    \"skipLibCheck\": false,\n    \"module\": \"Preserve\",\n    \"moduleResolution\": \"Bundler\"\n  },\n  \"include\": [\n    \"index.ts\"\n  ]\n}");
  await writeFile(join(consumer, "tsconfig.nodenext.json"), "{\n  \"compilerOptions\": {\n    \"target\": \"ES2023\",\n    \"lib\": [\n      \"ES2023\",\n      \"DOM\",\n      \"DOM.Iterable\"\n    ],\n    \"types\": [\n      \"bun\",\n      \"node\"\n    ],\n    \"strict\": true,\n    \"noEmit\": true,\n    \"skipLibCheck\": false,\n    \"module\": \"NodeNext\",\n    \"moduleResolution\": \"NodeNext\"\n  },\n  \"include\": [\n    \"index.ts\"\n  ]\n}");
  await run([process.execPath, "x", "tsc", "-p", "./tsconfig.bundler.json"], consumer);
  await run([process.execPath, "x", "tsc", "-p", "./tsconfig.nodenext.json"], consumer);
} finally {
  await rm(work, { recursive: true, force: true });
}
