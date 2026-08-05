import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  installMetadataSearchExecutable,
  metadataSearchExecutableName,
  metadataSearchToolCommand,
  runMetadataSearchTool,
  type MetadataSearchToolRunnerDependencies,
} from "./runner";

const executableName = metadataSearchExecutableName();

function fixture(): {
  readonly root: string;
  readonly toolDirectory: string;
  readonly sourcePath: string;
  readonly cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "kb-metadata-runner-test-"));
  const toolDirectory = join(root, "tool");
  const sourceDirectory = join(root, "source");
  mkdirSync(toolDirectory, { mode: 0o700 });
  mkdirSync(sourceDirectory, { mode: 0o700 });
  const sourcePath = join(sourceDirectory, executableName);
  writeFileSync(sourcePath, "new executable", { mode: 0o700 });
  return {
    root,
    toolDirectory,
    sourcePath,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function controlledRunner(
  toolDirectory: string,
  runCargo: NonNullable<MetadataSearchToolRunnerDependencies["runCargo"]>,
  additions: Partial<MetadataSearchToolRunnerDependencies> = {},
): {
  readonly dependencies: MetadataSearchToolRunnerDependencies;
  readonly targetDirectory: string;
  readonly wasRemoved: () => boolean;
} {
  const targetDirectory = mkdtempSync(
    join(tmpdir(), "kb-metadata-runner-target-test-"),
  );
  let removed = false;
  return {
    targetDirectory,
    wasRemoved: () => removed,
    dependencies: {
      toolDirectory,
      createTemporaryDirectory: () => targetDirectory,
      removeTemporaryDirectory: (path) => {
        expect(path).toBe(targetDirectory);
        removed = true;
        rmSync(path, { recursive: true, force: true });
      },
      runCargo,
      ...additions,
    },
  };
}

function cargoOutputPath(command: readonly string[], platform = process.platform): string {
  const targetIndex = command.indexOf("--target-dir");
  const targetDirectory = command[targetIndex + 1];
  if (targetIndex < 0 || targetDirectory === undefined) {
    throw new Error("test command did not contain --target-dir");
  }
  return join(
    targetDirectory,
    "release",
    metadataSearchExecutableName(platform),
  );
}

describe("metadata-search tool runner", () => {
  test("keeps Cargo output in an explicit external target directory", () => {
    expect(metadataSearchToolCommand(
      "check",
      "/tmp/kb-tool-target",
      "/tmp/kb-tool",
    )).toEqual([
      "cargo",
      "check",
      "--all-targets",
      "--locked",
      "--manifest-path",
      "/tmp/kb-tool/Cargo.toml",
      "--target-dir",
      "/tmp/kb-tool-target",
    ]);
    expect(metadataSearchToolCommand(
      "build",
      "/tmp/kb-tool-target",
      "/tmp/kb-tool",
    )).toContain("--release");
    expect(() => metadataSearchToolCommand("check", "target"))
      .toThrow("target directory must be absolute");
  });

  test("uses the portable executable name", () => {
    expect(metadataSearchExecutableName("darwin")).toBe("kb-url-metadata-search");
    expect(metadataSearchExecutableName("linux")).toBe("kb-url-metadata-search");
    expect(metadataSearchExecutableName("win32")).toBe("kb-url-metadata-search.exe");
  });

  test("runs check ephemerally and always removes its Cargo target", () => {
    const item = fixture();
    try {
      const runner = controlledRunner(item.toolDirectory, (command, options) => {
        expect(command).toContain("--all-targets");
        expect(options.cwd).toBe(item.toolDirectory);
        expect(options.environment.CARGO_INCREMENTAL).toBe("0");
        return 0;
      });
      expect(runMetadataSearchTool("check", runner.dependencies)).toBe(0);
      expect(runner.wasRemoved()).toBe(true);
      expect(lstatSync(runner.targetDirectory, { throwIfNoEntry: false })).toBeUndefined();
      expect(lstatSync(join(item.toolDirectory, "target"), {
        throwIfNoEntry: false,
      })).toBeUndefined();
    } finally {
      item.cleanup();
    }
  });

  test("installs only a validated release executable with private permissions", () => {
    const item = fixture();
    try {
      const runner = controlledRunner(item.toolDirectory, (command) => {
        const outputPath = cargoOutputPath(command);
        mkdirSync(join(outputPath, ".."), { recursive: true, mode: 0o700 });
        writeFileSync(outputPath, "built executable", { mode: 0o755 });
        return 0;
      });
      expect(runMetadataSearchTool("build", runner.dependencies)).toBe(0);
      expect(runner.wasRemoved()).toBe(true);
      const destination = join(
        item.toolDirectory,
        "target",
        "release",
        executableName,
      );
      expect(readFileSync(destination, "utf8")).toBe("built executable");
      if (process.platform !== "win32") {
        expect(lstatSync(destination).mode & 0o777).toBe(0o700);
        expect(lstatSync(join(item.toolDirectory, "target")).mode & 0o777).toBe(0o700);
        expect(lstatSync(join(item.toolDirectory, "target", "release")).mode & 0o777)
          .toBe(0o700);
      }
      expect(readdirSync(join(item.toolDirectory, "target", "release")))
        .toEqual([executableName]);
    } finally {
      item.cleanup();
    }
  });

  test("uses the Windows release name without requiring POSIX execute bits", () => {
    const item = fixture();
    try {
      const runner = controlledRunner(
        item.toolDirectory,
        (command) => {
          const outputPath = cargoOutputPath(command, "win32");
          mkdirSync(join(outputPath, ".."), { recursive: true, mode: 0o700 });
          writeFileSync(outputPath, "windows executable", { mode: 0o600 });
          return 0;
        },
        { platform: "win32" },
      );
      expect(runMetadataSearchTool("build", runner.dependencies)).toBe(0);
      expect(readFileSync(
        join(item.toolDirectory, "target", "release", "kb-url-metadata-search.exe"),
        "utf8",
      )).toBe("windows executable");
    } finally {
      item.cleanup();
    }
  });

  test("preserves the installed executable when Cargo fails", () => {
    const item = fixture();
    try {
      const releaseDirectory = join(item.toolDirectory, "target", "release");
      mkdirSync(releaseDirectory, { recursive: true, mode: 0o700 });
      const destination = join(releaseDirectory, executableName);
      writeFileSync(destination, "previous executable", { mode: 0o700 });
      const runner = controlledRunner(item.toolDirectory, () => 17);
      expect(runMetadataSearchTool("build", runner.dependencies)).toBe(17);
      expect(readFileSync(destination, "utf8")).toBe("previous executable");
      expect(runner.wasRemoved()).toBe(true);
    } finally {
      item.cleanup();
    }
  });

  test("preserves the installed executable when Cargo omits its output", () => {
    const item = fixture();
    try {
      const releaseDirectory = join(item.toolDirectory, "target", "release");
      mkdirSync(releaseDirectory, { recursive: true, mode: 0o700 });
      const destination = join(releaseDirectory, executableName);
      writeFileSync(destination, "previous executable", { mode: 0o700 });
      const runner = controlledRunner(item.toolDirectory, () => 0);
      expect(() => runMetadataSearchTool("build", runner.dependencies)).toThrow();
      expect(readFileSync(destination, "utf8")).toBe("previous executable");
      expect(runner.wasRemoved()).toBe(true);
    } finally {
      item.cleanup();
    }
  });

  test("rejects non-executable and oversized Cargo outputs", () => {
    for (const kind of ["non-executable", "oversized"] as const) {
      const item = fixture();
      try {
        const runner = controlledRunner(item.toolDirectory, (command) => {
          const outputPath = cargoOutputPath(command);
          mkdirSync(join(outputPath, ".."), { recursive: true, mode: 0o700 });
          writeFileSync(outputPath, "x", { mode: 0o700 });
          if (kind === "non-executable") chmodSync(outputPath, 0o600);
          else truncateSync(outputPath, 64 * 1024 * 1024 + 1);
          return 0;
        });
        expect(() => runMetadataSearchTool("build", runner.dependencies)).toThrow(
          kind === "non-executable" ? "must be executable" : "must contain",
        );
        expect(runner.wasRemoved()).toBe(true);
      } finally {
        item.cleanup();
      }
    }
  });

  test("rejects symbolic and hard-linked Cargo outputs", () => {
    for (const kind of ["symbolic", "hard"] as const) {
      const item = fixture();
      try {
        const runner = controlledRunner(item.toolDirectory, (command) => {
          const outputPath = cargoOutputPath(command);
          mkdirSync(join(outputPath, ".."), { recursive: true, mode: 0o700 });
          if (kind === "symbolic") symlinkSync(item.sourcePath, outputPath);
          else linkSync(item.sourcePath, outputPath);
          return 0;
        });
        expect(() => runMetadataSearchTool("build", runner.dependencies)).toThrow();
        expect(runner.wasRemoved()).toBe(true);
      } finally {
        item.cleanup();
      }
    }
  });

  test("rejects linked install directories", () => {
    const item = fixture();
    try {
      const outside = join(item.root, "outside");
      mkdirSync(outside, { mode: 0o700 });
      symlinkSync(outside, join(item.toolDirectory, "target"));
      expect(() => installMetadataSearchExecutable({
        sourcePath: item.sourcePath,
        toolDirectory: item.toolDirectory,
      })).toThrow("target directory must be a real directory");
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      item.cleanup();
    }
  });

  test("rejects a linked existing destination", () => {
    const item = fixture();
    try {
      const releaseDirectory = join(item.toolDirectory, "target", "release");
      mkdirSync(releaseDirectory, { recursive: true, mode: 0o700 });
      symlinkSync(item.sourcePath, join(releaseDirectory, executableName));
      expect(() => installMetadataSearchExecutable({
        sourcePath: item.sourcePath,
        toolDirectory: item.toolDirectory,
      })).toThrow("must be a regular file");
      expect(readFileSync(item.sourcePath, "utf8")).toBe("new executable");
    } finally {
      item.cleanup();
    }
  });

  test("rejects a hard-linked existing destination", () => {
    const item = fixture();
    try {
      const releaseDirectory = join(item.toolDirectory, "target", "release");
      mkdirSync(releaseDirectory, { recursive: true, mode: 0o700 });
      linkSync(item.sourcePath, join(releaseDirectory, executableName));
      expect(() => installMetadataSearchExecutable({
        sourcePath: item.sourcePath,
        toolDirectory: item.toolDirectory,
      })).toThrow("must not be hard-linked");
      expect(readFileSync(item.sourcePath, "utf8")).toBe("new executable");
    } finally {
      item.cleanup();
    }
  });

  test("rejects release-directory replacement before the atomic install", () => {
    const item = fixture();
    try {
      const movedRelease = join(item.toolDirectory, "target", "moved-release");
      expect(() => installMetadataSearchExecutable({
        sourcePath: item.sourcePath,
        toolDirectory: item.toolDirectory,
        beforeInstall: ({ releaseDirectory }) => {
          renameSync(releaseDirectory, movedRelease);
          mkdirSync(releaseDirectory, { mode: 0o700 });
        },
      })).toThrow("release directory changed during installation");
      expect(lstatSync(
        join(item.toolDirectory, "target", "release", executableName),
        { throwIfNoEntry: false },
      )).toBeUndefined();
      expect(readdirSync(movedRelease)).toEqual([]);
    } finally {
      item.cleanup();
    }
  });

  test("cannot redirect the final rename through a swapped release symlink", () => {
    const item = fixture();
    try {
      const movedRelease = join(item.toolDirectory, "target", "moved-release");
      const outside = join(item.root, "outside");
      mkdirSync(outside, { mode: 0o700 });
      expect(() => installMetadataSearchExecutable({
        sourcePath: item.sourcePath,
        toolDirectory: item.toolDirectory,
        beforeCommit: ({ releaseDirectory }) => {
          renameSync(releaseDirectory, movedRelease);
          symlinkSync(outside, releaseDirectory, "dir");
        },
      })).toThrow();
      expect(readdirSync(outside)).toEqual([]);
      expect(readdirSync(movedRelease)).toEqual([]);
    } finally {
      item.cleanup();
    }
  });

  test("does not overwrite a destination that appears at the commit boundary", () => {
    const item = fixture();
    try {
      const destination = join(
        item.toolDirectory,
        "target",
        "release",
        executableName,
      );
      expect(() => installMetadataSearchExecutable({
        sourcePath: item.sourcePath,
        toolDirectory: item.toolDirectory,
        beforeCommit: () => writeFileSync(
          destination,
          "commit-boundary replacement",
          { mode: 0o700 },
        ),
      })).toThrow("destination appeared during installation");
      expect(readFileSync(destination, "utf8"))
        .toBe("commit-boundary replacement");
      expect(readdirSync(item.toolDirectory).filter((name) => name.endsWith(".tmp")))
        .toEqual([]);
    } finally {
      item.cleanup();
    }
  });

  test("rejects a destination that appears and removes its staging file", () => {
    const item = fixture();
    try {
      const destination = join(
        item.toolDirectory,
        "target",
        "release",
        executableName,
      );
      expect(() => installMetadataSearchExecutable({
        sourcePath: item.sourcePath,
        toolDirectory: item.toolDirectory,
        beforeInstall: () => writeFileSync(destination, "unexpected", { mode: 0o700 }),
      })).toThrow("destination appeared during installation");
      expect(readFileSync(destination, "utf8")).toBe("unexpected");
      expect(readdirSync(join(item.toolDirectory, "target", "release")))
        .toEqual([executableName]);
    } finally {
      item.cleanup();
    }
  });

  test("does not unlink a replacement at the randomized staging path", () => {
    const item = fixture();
    try {
      let replacementPath = "";
      expect(() => installMetadataSearchExecutable({
        sourcePath: item.sourcePath,
        toolDirectory: item.toolDirectory,
        beforeInstall: () => {
          const stagingName = readdirSync(item.toolDirectory)
            .find((name) => name.endsWith(".tmp"));
          if (stagingName === undefined) throw new Error("missing staging fixture");
          replacementPath = join(item.toolDirectory, stagingName);
          rmSync(replacementPath);
          writeFileSync(replacementPath, "unrelated staging replacement", { mode: 0o700 });
        },
      })).toThrow("refusing to remove a replaced staging executable");
      expect(readFileSync(replacementPath, "utf8"))
        .toBe("unrelated staging replacement");
    } finally {
      item.cleanup();
    }
  });

  test("does not unlink a replacement at the randomized backup path", () => {
    const item = fixture();
    try {
      const releaseDirectory = join(item.toolDirectory, "target", "release");
      mkdirSync(releaseDirectory, { recursive: true, mode: 0o700 });
      const destination = join(releaseDirectory, executableName);
      writeFileSync(destination, "previous executable", { mode: 0o700 });
      let replacementPath = "";
      expect(() => installMetadataSearchExecutable({
        sourcePath: item.sourcePath,
        toolDirectory: item.toolDirectory,
        beforeInstall: () => {
          const backupName = readdirSync(item.toolDirectory)
            .find((name) => name.endsWith(".backup"));
          if (backupName === undefined) throw new Error("missing backup fixture");
          replacementPath = join(item.toolDirectory, backupName);
          rmSync(replacementPath);
          writeFileSync(replacementPath, "unrelated backup replacement", { mode: 0o700 });
        },
      })).toThrow("refusing to remove a replaced executable backup");
      expect(readFileSync(replacementPath, "utf8"))
        .toBe("unrelated backup replacement");
      expect(readFileSync(destination, "utf8")).toBe("previous executable");
    } finally {
      item.cleanup();
    }
  });

  test("retains the validated new executable after late backup fsync failure", () => {
    const item = fixture();
    try {
      const releaseDirectory = join(item.toolDirectory, "target", "release");
      mkdirSync(releaseDirectory, { recursive: true, mode: 0o700 });
      const destination = join(releaseDirectory, executableName);
      writeFileSync(destination, "previous executable", { mode: 0o700 });
      expect(() => installMetadataSearchExecutable({
        sourcePath: item.sourcePath,
        toolDirectory: item.toolDirectory,
        syncDirectory: (_descriptor, phase) => {
          if (phase === "tool-after-backup-removal") {
            throw new Error("late directory fsync failed");
          }
        },
      })).toThrow("late directory fsync failed");
      expect(readFileSync(destination, "utf8")).toBe("new executable");
      expect(readdirSync(item.toolDirectory).filter((name) => name.endsWith(".backup")))
        .toEqual([]);
    } finally {
      item.cleanup();
    }
  });

  test("cleans a legitimate backup even when staging-path drift is preserved", () => {
    const item = fixture();
    try {
      const releaseDirectory = join(item.toolDirectory, "target", "release");
      mkdirSync(releaseDirectory, { recursive: true, mode: 0o700 });
      const destination = join(releaseDirectory, executableName);
      writeFileSync(destination, "previous executable", { mode: 0o700 });
      let replacementPath = "";
      expect(() => installMetadataSearchExecutable({
        sourcePath: item.sourcePath,
        toolDirectory: item.toolDirectory,
        beforeInstall: () => {
          const stagingName = readdirSync(item.toolDirectory)
            .find((name) => name.endsWith(".tmp"));
          if (stagingName === undefined) throw new Error("missing staging fixture");
          replacementPath = join(item.toolDirectory, stagingName);
          rmSync(replacementPath);
          writeFileSync(replacementPath, "unrelated staging replacement", { mode: 0o700 });
        },
      })).toThrow("refusing to remove a replaced staging executable");
      expect(readFileSync(replacementPath, "utf8"))
        .toBe("unrelated staging replacement");
      expect(readFileSync(destination, "utf8")).toBe("previous executable");
      expect(readdirSync(item.toolDirectory).filter((name) => name.endsWith(".backup")))
        .toEqual([]);
    } finally {
      item.cleanup();
    }
  });

  test("refuses recursive cleanup after Cargo target replacement", () => {
    const item = fixture();
    let runner: ReturnType<typeof controlledRunner> | null = null;
    let movedTarget = "";
    try {
      const currentRunner = controlledRunner(item.toolDirectory, (command) => {
        const targetIndex = command.indexOf("--target-dir");
        const targetDirectory = command[targetIndex + 1];
        if (targetDirectory === undefined) throw new Error("missing target fixture");
        movedTarget = `${targetDirectory}.moved`;
        renameSync(targetDirectory, movedTarget);
        mkdirSync(targetDirectory, { mode: 0o700 });
        writeFileSync(join(targetDirectory, "unrelated"), "keep");
        return 0;
      });
      runner = currentRunner;
      expect(() => runMetadataSearchTool("check", currentRunner.dependencies))
        .toThrow("Cargo target directory changed before cleanup");
      expect(currentRunner.wasRemoved()).toBe(false);
      expect(readFileSync(join(currentRunner.targetDirectory, "unrelated"), "utf8"))
        .toBe("keep");
    } finally {
      if (runner !== null) {
        rmSync(runner.targetDirectory, { recursive: true, force: true });
      }
      if (movedTarget !== "") rmSync(movedTarget, { recursive: true, force: true });
      item.cleanup();
    }
  });
});
