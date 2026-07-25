import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const packageName = "@cclrte/oh";
const importSpecifiers = ["@cclrte/oh","@cclrte/oh/agent-context","@cclrte/oh/agent-guide-audit","@cclrte/oh/browser-profiles","@cclrte/oh/capture","@cclrte/oh/clip/acquire","@cclrte/oh/clip/args","@cclrte/oh/clip/bounded-byte-buffer","@cclrte/oh/clip/cli","@cclrte/oh/clip/cookies","@cclrte/oh/clip/doctor","@cclrte/oh/clip/network","@cclrte/oh/clip/network-proxy","@cclrte/oh/clip/persist","@cclrte/oh/clip/terminal","@cclrte/oh/graph","@cclrte/oh/navigation","@cclrte/oh/pdf","@cclrte/oh/query","@cclrte/oh/semantic"];
const binNames = ["oh"];
const verificationPackages = ["@types/bun@^1.3.14","fast-check@^4.8.0","typescript@^6.0.3"];

async function run(command: string[], cwd: string): Promise<void> {
  const process = Bun.spawn(command, { cwd, stdout: "inherit", stderr: "inherit" });
  const exitCode = await process.exited;
  if (exitCode !== 0) throw new Error(`Command failed (${String(exitCode)}): ${command.join(" ")}`);
}

const repository = process.cwd();
const work = await mkdtemp(join(tmpdir(), "cclrte-package-smoke-"));
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
  await writeFile(join(consumer, "index.ts"), "import * as surface0 from \"@cclrte/oh\";\nimport * as surface1 from \"@cclrte/oh/agent-context\";\nimport * as surface2 from \"@cclrte/oh/agent-guide-audit\";\nimport * as surface3 from \"@cclrte/oh/browser-profiles\";\nimport * as surface4 from \"@cclrte/oh/capture\";\nimport * as surface5 from \"@cclrte/oh/clip/acquire\";\nimport * as surface6 from \"@cclrte/oh/clip/args\";\nimport * as surface7 from \"@cclrte/oh/clip/bounded-byte-buffer\";\nimport * as surface8 from \"@cclrte/oh/clip/cli\";\nimport * as surface9 from \"@cclrte/oh/clip/cookies\";\nimport * as surface10 from \"@cclrte/oh/clip/doctor\";\nimport * as surface11 from \"@cclrte/oh/clip/network\";\nimport * as surface12 from \"@cclrte/oh/clip/network-proxy\";\nimport * as surface13 from \"@cclrte/oh/clip/persist\";\nimport * as surface14 from \"@cclrte/oh/clip/terminal\";\nimport * as surface15 from \"@cclrte/oh/graph\";\nimport * as surface16 from \"@cclrte/oh/navigation\";\nimport * as surface17 from \"@cclrte/oh/pdf\";\nimport * as surface18 from \"@cclrte/oh/query\";\nimport * as surface19 from \"@cclrte/oh/semantic\";\nvoid [surface0, surface1, surface2, surface3, surface4, surface5, surface6, surface7, surface8, surface9, surface10, surface11, surface12, surface13, surface14, surface15, surface16, surface17, surface18, surface19];\n");
  await writeFile(join(consumer, "tsconfig.bundler.json"), "{\n  \"compilerOptions\": {\n    \"target\": \"ES2023\",\n    \"lib\": [\n      \"ES2023\",\n      \"DOM\",\n      \"DOM.Iterable\"\n    ],\n    \"types\": [\n      \"bun\",\n      \"node\"\n    ],\n    \"strict\": true,\n    \"noEmit\": true,\n    \"skipLibCheck\": false,\n    \"module\": \"Preserve\",\n    \"moduleResolution\": \"Bundler\"\n  },\n  \"include\": [\n    \"index.ts\"\n  ]\n}");
  await writeFile(join(consumer, "tsconfig.nodenext.json"), "{\n  \"compilerOptions\": {\n    \"target\": \"ES2023\",\n    \"lib\": [\n      \"ES2023\",\n      \"DOM\",\n      \"DOM.Iterable\"\n    ],\n    \"types\": [\n      \"bun\",\n      \"node\"\n    ],\n    \"strict\": true,\n    \"noEmit\": true,\n    \"skipLibCheck\": false,\n    \"module\": \"NodeNext\",\n    \"moduleResolution\": \"NodeNext\"\n  },\n  \"include\": [\n    \"index.ts\"\n  ]\n}");
  await run([process.execPath, "x", "tsc", "-p", "./tsconfig.bundler.json"], consumer);
  await run([process.execPath, "x", "tsc", "-p", "./tsconfig.nodenext.json"], consumer);
} finally {
  await rm(work, { recursive: true, force: true });
}
