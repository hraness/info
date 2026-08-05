import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  type BigIntStats,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export type MetadataSearchToolAction = "build" | "check";

const TEMPORARY_DIRECTORY_PREFIX = "hraness-kb-metadata-search-tool-";
const MAX_EXECUTABLE_BYTES = 64 * 1024 * 1024;
const COPY_BUFFER_BYTES = 64 * 1024;

type DirectoryBinding = {
  readonly path: string;
  readonly descriptor: number;
  readonly identity: BigIntStats;
};

type EnsuredDirectory = {
  readonly binding: DirectoryBinding;
  readonly created: boolean;
};

export type MetadataSearchDirectorySyncPhase =
  | "tool-after-target"
  | "target-after-release"
  | "tool-before-commit"
  | "release-before-commit"
  | "release-after-commit"
  | "tool-after-commit"
  | "tool-after-backup-removal"
  | "release-after-rollback"
  | "tool-after-rollback";

export type MetadataSearchToolRunnerDependencies = {
  readonly toolDirectory?: string;
  readonly platform?: NodeJS.Platform;
  readonly createTemporaryDirectory?: () => string;
  readonly removeTemporaryDirectory?: (
    path: string,
    identity: BigIntStats,
  ) => void;
  readonly runCargo?: (
    command: readonly string[],
    options: { readonly cwd: string; readonly environment: NodeJS.ProcessEnv },
  ) => number;
  readonly beforeInstall?: (input: {
    readonly sourcePath: string;
    readonly targetDirectory: string;
    readonly releaseDirectory: string;
    readonly destinationPath: string;
  }) => void;
  readonly beforeCommit?: (input: {
    readonly sourcePath: string;
    readonly targetDirectory: string;
    readonly releaseDirectory: string;
    readonly destinationPath: string;
  }) => void;
  readonly syncDirectory?: (
    descriptor: number,
    phase: MetadataSearchDirectorySyncPhase,
  ) => void;
};

function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
}

function directoryFlag(): number {
  return typeof constants.O_DIRECTORY === "number" ? constants.O_DIRECTORY : 0;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && typeof error.code === "string"
    ? error.code
    : undefined;
}

function maybeLstat(path: string): BigIntStats | null {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

function sameDirectoryIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return sameDirectoryIdentity(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function sameInstalledFile(left: BigIntStats, right: BigIntStats): boolean {
  return sameDirectoryIdentity(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs;
}

function assertOwnedByCurrentUser(stat: BigIntStats, label: string): void {
  if (process.platform === "win32" || typeof process.getuid !== "function") return;
  if (stat.uid !== BigInt(process.getuid())) {
    throw new Error(`${label} must be owned by the current user`);
  }
}

function assertDirectory(stat: BigIntStats | null, label: string): asserts stat is BigIntStats {
  if (stat === null || stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} must be a real directory`);
  }
  assertOwnedByCurrentUser(stat, label);
}

function openBoundDirectory(path: string, label: string): DirectoryBinding {
  const before = maybeLstat(path);
  assertDirectory(before, label);
  const descriptor = openSync(
    path,
    constants.O_RDONLY | directoryFlag() | noFollowFlag(),
  );
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isDirectory() || !sameDirectoryIdentity(before, opened)) {
      throw new Error(`${label} changed while it was opened`);
    }
    return { path, descriptor, identity: opened };
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function assertDirectoryBinding(binding: DirectoryBinding, label: string): void {
  const byPath = maybeLstat(binding.path);
  assertDirectory(byPath, label);
  const byDescriptor = fstatSync(binding.descriptor, { bigint: true });
  if (
    !sameDirectoryIdentity(binding.identity, byPath)
    || !sameDirectoryIdentity(binding.identity, byDescriptor)
  ) {
    throw new Error(`${label} changed during installation`);
  }
}

function ensurePrivateDirectory(path: string, label: string): EnsuredDirectory {
  let created = false;
  try {
    mkdirSync(path, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
  const before = maybeLstat(path);
  assertDirectory(before, label);
  const binding = openBoundDirectory(path, label);
  try {
    if (process.platform !== "win32") {
      fchmodSync(binding.descriptor, 0o700);
    }
    const identity = fstatSync(binding.descriptor, { bigint: true });
    return { binding: { ...binding, identity }, created };
  } catch (error) {
    closeSync(binding.descriptor);
    throw error;
  }
}

function assertExecutableSource(
  stat: BigIntStats,
  platform: NodeJS.Platform,
): void {
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("Cargo release output must be a regular file");
  }
  if (stat.nlink !== 1n) {
    throw new Error("Cargo release output must not be hard-linked");
  }
  if (stat.size < 1n || stat.size > BigInt(MAX_EXECUTABLE_BYTES)) {
    throw new Error(
      `Cargo release output must contain 1-${MAX_EXECUTABLE_BYTES} bytes`,
    );
  }
  if (platform !== "win32" && (stat.mode & 0o111n) === 0n) {
    throw new Error("Cargo release output must be executable");
  }
  assertOwnedByCurrentUser(stat, "Cargo release output");
}

function assertExistingDestination(
  stat: BigIntStats,
  platform: NodeJS.Platform,
): void {
  assertExecutableSource(stat, platform);
  if (platform !== "win32" && (stat.mode & 0o777n) !== 0o700n) {
    throw new Error("installed metadata-search executable has unsafe permissions");
  }
}

function writeAll(descriptor: number, buffer: Buffer, length: number): void {
  let offset = 0;
  while (offset < length) {
    const written = writeSync(descriptor, buffer, offset, length - offset);
    if (written < 1) throw new Error("could not write the staged executable");
    offset += written;
  }
}

function copyValidatedExecutable(
  sourcePath: string,
  stagingPath: string,
  platform: NodeJS.Platform,
): BigIntStats {
  const sourceDescriptor = openSync(
    sourcePath,
    constants.O_RDONLY | noFollowFlag(),
  );
  let stagingDescriptor: number | null = null;
  let staged: BigIntStats | null = null;
  let complete = false;
  try {
    const sourceBefore = fstatSync(sourceDescriptor, { bigint: true });
    assertExecutableSource(sourceBefore, platform);
    stagingDescriptor = openSync(
      stagingPath,
      constants.O_CREAT
        | constants.O_EXCL
        | constants.O_WRONLY
        | noFollowFlag(),
      0o700,
    );
    if (platform !== "win32") fchmodSync(stagingDescriptor, 0o700);

    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    let copiedBytes = 0;
    const expectedBytes = Number(sourceBefore.size);
    while (copiedBytes < expectedBytes) {
      const bytesRead = readSync(
        sourceDescriptor,
        buffer,
        0,
        Math.min(buffer.byteLength, expectedBytes - copiedBytes),
        null,
      );
      if (bytesRead < 1) {
        throw new Error("Cargo release output changed while it was copied");
      }
      writeAll(stagingDescriptor, buffer, bytesRead);
      copiedBytes += bytesRead;
    }
    if (readSync(sourceDescriptor, buffer, 0, 1, null) !== 0) {
      throw new Error("Cargo release output grew while it was copied");
    }

    const sourceAfter = fstatSync(sourceDescriptor, { bigint: true });
    if (!sameFileIdentity(sourceBefore, sourceAfter)) {
      throw new Error("Cargo release output changed while it was copied");
    }
    const sourceByPath = maybeLstat(sourcePath);
    if (sourceByPath === null || !sameFileIdentity(sourceBefore, sourceByPath)) {
      throw new Error("Cargo release output path changed while it was copied");
    }

    fsyncSync(stagingDescriptor);
    staged = fstatSync(stagingDescriptor, { bigint: true });
    if (!staged.isFile() || staged.nlink !== 1n || staged.size !== sourceBefore.size) {
      throw new Error("staged metadata-search executable failed validation");
    }
    complete = true;
    return staged;
  } finally {
    if (stagingDescriptor !== null) {
      if (!complete) staged = fstatSync(stagingDescriptor, { bigint: true });
      closeSync(stagingDescriptor);
    }
    closeSync(sourceDescriptor);
    if (!complete) {
      removeIdentityBoundFile(stagingPath, staged, "incomplete staged executable");
    }
  }
}

function assertDestinationUnchanged(
  destinationPath: string,
  expected: BigIntStats | null,
  platform: NodeJS.Platform,
): void {
  const current = maybeLstat(destinationPath);
  if (expected === null) {
    if (current !== null) {
      throw new Error("metadata-search executable destination appeared during installation");
    }
    return;
  }
  if (current === null || !sameFileIdentity(expected, current)) {
    throw new Error("metadata-search executable destination changed during installation");
  }
  assertExistingDestination(current, platform);
}

function removeIdentityBoundFile(
  path: string,
  expected: BigIntStats | null,
  label: string,
): void {
  const current = maybeLstat(path);
  if (current === null) return;
  if (
    expected === null
    || current.isDirectory()
    || !sameFileIdentity(expected, current)
  ) {
    throw new Error(`refusing to remove a replaced ${label}`);
  }
  rmSync(path, { force: true });
}

export function metadataSearchExecutableName(
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === "win32"
    ? "kb-url-metadata-search.exe"
    : "kb-url-metadata-search";
}

export function metadataSearchToolCommand(
  action: MetadataSearchToolAction,
  targetDirectory: string,
  toolDirectory = import.meta.dir,
): readonly string[] {
  if (!isAbsolute(targetDirectory)) {
    throw new Error("metadata-search tool target directory must be absolute");
  }
  if (!isAbsolute(toolDirectory)) {
    throw new Error("metadata-search tool directory must be absolute");
  }
  return Object.freeze([
    "cargo",
    action,
    ...(action === "check" ? ["--all-targets"] : ["--release"]),
    "--locked",
    "--manifest-path",
    join(toolDirectory, "Cargo.toml"),
    "--target-dir",
    targetDirectory,
  ]);
}

export function installMetadataSearchExecutable(input: {
  readonly sourcePath: string;
  readonly toolDirectory: string;
  readonly platform?: NodeJS.Platform;
  readonly beforeInstall?: MetadataSearchToolRunnerDependencies["beforeInstall"];
  readonly beforeCommit?: MetadataSearchToolRunnerDependencies["beforeCommit"];
  readonly syncDirectory?: MetadataSearchToolRunnerDependencies["syncDirectory"];
}): string {
  const toolDirectory = resolve(input.toolDirectory);
  const platform = input.platform ?? process.platform;
  const executableName = metadataSearchExecutableName(platform);
  const sourcePath = resolve(input.sourcePath);
  const targetDirectory = join(toolDirectory, "target");
  const releaseDirectory = join(targetDirectory, "release");
  const destinationPath = join(releaseDirectory, executableName);
  const stagingName = `.${executableName}.${process.pid}.${randomUUID()}.tmp`;
  const backupName = `.${executableName}.${process.pid}.${randomUUID()}.backup`;
  const stagingPath = join(toolDirectory, stagingName);
  const backupPath = join(toolDirectory, backupName);
  const syncDirectory = input.syncDirectory
    ?? ((descriptor: number) => fsyncSync(descriptor));

  const toolBinding = openBoundDirectory(toolDirectory, "metadata-search tool directory");
  let targetBinding: DirectoryBinding | null = null;
  let releaseBinding: DirectoryBinding | null = null;
  let stagedIdentity: BigIntStats | null = null;
  let backupIdentity: BigIntStats | null = null;
  let committed = false;
  let backupDestroyed = false;
  let installFailure: { readonly error: unknown } | null = null;
  let installedPath: string | null = null;
  const cleanupErrors: unknown[] = [];
  try {
    const target = ensurePrivateDirectory(
      targetDirectory,
      "metadata-search target directory",
    );
    targetBinding = target.binding;
    assertDirectoryBinding(toolBinding, "metadata-search tool directory");
    syncDirectory(toolBinding.descriptor, "tool-after-target");
    const release = ensurePrivateDirectory(
      releaseDirectory,
      "metadata-search release directory",
    );
    releaseBinding = release.binding;
    assertDirectoryBinding(targetBinding, "metadata-search target directory");
    syncDirectory(targetBinding.descriptor, "target-after-release");

    const previousDestination = maybeLstat(destinationPath);
    if (previousDestination !== null) {
      assertExistingDestination(previousDestination, platform);
      backupIdentity = copyValidatedExecutable(
        destinationPath,
        backupPath,
        platform,
      );
    }

    stagedIdentity = copyValidatedExecutable(sourcePath, stagingPath, platform);
    input.beforeInstall?.({
      sourcePath,
      targetDirectory,
      releaseDirectory,
      destinationPath,
    });

    assertDirectoryBinding(toolBinding, "metadata-search tool directory");
    assertDirectoryBinding(targetBinding, "metadata-search target directory");
    assertDirectoryBinding(releaseBinding, "metadata-search release directory");
    assertDestinationUnchanged(destinationPath, previousDestination, platform);
    const stagedByPath = maybeLstat(stagingPath);
    if (stagedByPath === null || !sameFileIdentity(stagedIdentity, stagedByPath)) {
      throw new Error("staged metadata-search executable changed before installation");
    }
    if (backupIdentity !== null) {
      const backup = maybeLstat(backupPath);
      if (backup === null || !sameFileIdentity(backupIdentity, backup)) {
        throw new Error("metadata-search executable backup changed before installation");
      }
    }

    input.beforeCommit?.({
      sourcePath,
      targetDirectory,
      releaseDirectory,
      destinationPath,
    });
    assertDirectoryBinding(toolBinding, "metadata-search tool directory");
    assertDirectoryBinding(targetBinding, "metadata-search target directory");
    assertDirectoryBinding(releaseBinding, "metadata-search release directory");
    assertDestinationUnchanged(destinationPath, previousDestination, platform);
    const commitStaging = maybeLstat(stagingPath);
    if (commitStaging === null || !sameFileIdentity(stagedIdentity, commitStaging)) {
      throw new Error("staged metadata-search executable changed before commit");
    }
    if (backupIdentity !== null) {
      const commitBackup = maybeLstat(backupPath);
      if (commitBackup === null || !sameFileIdentity(backupIdentity, commitBackup)) {
        throw new Error("metadata-search executable backup changed before commit");
      }
    }
    syncDirectory(toolBinding.descriptor, "tool-before-commit");
    syncDirectory(releaseBinding.descriptor, "release-before-commit");
    renameSync(stagingPath, destinationPath);
    committed = true;
    assertDirectoryBinding(toolBinding, "metadata-search tool directory");
    assertDirectoryBinding(targetBinding, "metadata-search target directory");
    assertDirectoryBinding(releaseBinding, "metadata-search release directory");
    const installed = maybeLstat(destinationPath);
    if (installed === null || !sameInstalledFile(stagedIdentity, installed)) {
      throw new Error("installed metadata-search executable failed identity validation");
    }
    assertExistingDestination(installed, platform);
    syncDirectory(releaseBinding.descriptor, "release-after-commit");
    syncDirectory(toolBinding.descriptor, "tool-after-commit");
    if (backupIdentity !== null) {
      const backup = maybeLstat(backupPath);
      if (backup === null || !sameFileIdentity(backupIdentity, backup)) {
        throw new Error("metadata-search executable backup changed during installation");
      }
      rmSync(backupPath, { force: true });
      backupDestroyed = true;
      syncDirectory(toolBinding.descriptor, "tool-after-backup-removal");
      backupIdentity = null;
    }
    installedPath = destinationPath;
  } catch (error) {
    let reportedError = error;
    if (
      committed
      && !backupDestroyed
      && releaseBinding !== null
      && stagedIdentity !== null
    ) {
      try {
        const installed = maybeLstat(destinationPath);
        if (installed === null || !sameInstalledFile(stagedIdentity, installed)) {
          throw new Error("refusing to replace an unrecognized failed install");
        }
        if (backupIdentity === null) {
          rmSync(destinationPath, { force: true });
        } else {
          const backup = maybeLstat(backupPath);
          if (backup === null || !sameFileIdentity(backupIdentity, backup)) {
            throw new Error("refusing to restore an unrecognized executable backup");
          }
          renameSync(backupPath, destinationPath);
          backupIdentity = null;
        }
        syncDirectory(releaseBinding.descriptor, "release-after-rollback");
        syncDirectory(toolBinding.descriptor, "tool-after-rollback");
      } catch (rollbackError) {
        reportedError = new AggregateError(
          [error, rollbackError],
          "metadata-search executable installation and rollback both failed",
        );
      }
    }
    installFailure = { error: reportedError };
  } finally {
    const attemptCleanup = (action: () => void): void => {
      try {
        action();
      } catch (error) {
        cleanupErrors.push(error);
      }
    };
    attemptCleanup(() => removeIdentityBoundFile(
      stagingPath,
      stagedIdentity,
      "staging executable",
    ));
    attemptCleanup(() => removeIdentityBoundFile(
      backupPath,
      backupIdentity,
      "executable backup",
    ));
    if (releaseBinding !== null) {
      const releaseDescriptor = releaseBinding.descriptor;
      attemptCleanup(() => closeSync(releaseDescriptor));
    }
    if (targetBinding !== null) {
      const targetDescriptor = targetBinding.descriptor;
      attemptCleanup(() => closeSync(targetDescriptor));
    }
    attemptCleanup(() => closeSync(toolBinding.descriptor));
  }
  const errors = [
    ...(installFailure === null ? [] : [installFailure.error]),
    ...cleanupErrors,
  ];
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    const details = errors.map((error) => error instanceof Error
      ? error.message
      : "unknown error").join("; ");
    throw new AggregateError(
      errors,
      `metadata-search executable installation or cleanup failed: ${details}`,
    );
  }
  if (installedPath === null) {
    throw new Error("metadata-search executable installation produced no outcome");
  }
  return installedPath;
}

function defaultTemporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), TEMPORARY_DIRECTORY_PREFIX));
}

function assertTemporaryDirectoryIdentity(
  path: string,
  expected: BigIntStats,
): void {
  const current = maybeLstat(path);
  assertDirectory(current, "Cargo target directory");
  if (!sameDirectoryIdentity(expected, current)) {
    throw new Error("Cargo target directory changed before cleanup");
  }
}

function removeOwnedTemporaryDirectory(
  path: string,
  identity: BigIntStats,
): void {
  const resolvedPath = resolve(path);
  const resolvedTemporaryRoot = resolve(tmpdir());
  if (
    dirname(resolvedPath) !== resolvedTemporaryRoot
    || !basename(resolvedPath).startsWith(TEMPORARY_DIRECTORY_PREFIX)
  ) {
    throw new Error("refusing to remove an unexpected Cargo target directory");
  }
  assertTemporaryDirectoryIdentity(resolvedPath, identity);
  rmSync(resolvedPath, { recursive: true, force: true });
}

function defaultCargoRunner(
  command: readonly string[],
  options: { readonly cwd: string; readonly environment: NodeJS.ProcessEnv },
): number {
  const result = Bun.spawnSync({
    cmd: [...command],
    cwd: options.cwd,
    env: options.environment,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return result.exitCode;
}

export function runMetadataSearchTool(
  action: MetadataSearchToolAction,
  dependencies: MetadataSearchToolRunnerDependencies = {},
): number {
  const toolDirectory = resolve(dependencies.toolDirectory ?? import.meta.dir);
  const platform = dependencies.platform ?? process.platform;
  const createTemporaryDirectory = dependencies.createTemporaryDirectory
    ?? defaultTemporaryDirectory;
  const removeTemporaryDirectory = dependencies.removeTemporaryDirectory
    ?? removeOwnedTemporaryDirectory;
  const runCargo = dependencies.runCargo ?? defaultCargoRunner;
  const createdTargetDirectory = createTemporaryDirectory();
  if (!isAbsolute(createdTargetDirectory)) {
    throw new Error("metadata-search tool temporary directory must be absolute");
  }
  const targetDirectory = resolve(createdTargetDirectory);
  const targetIdentity = maybeLstat(targetDirectory);
  assertDirectory(targetIdentity, "Cargo target directory");

  try {
    const command = metadataSearchToolCommand(action, targetDirectory, toolDirectory);
    const exitCode = runCargo(command, {
      cwd: toolDirectory,
      environment: { ...process.env, CARGO_INCREMENTAL: "0" },
    });
    if (exitCode !== 0 || action === "check") return exitCode;

    installMetadataSearchExecutable({
      sourcePath: join(
        targetDirectory,
        "release",
        metadataSearchExecutableName(platform),
      ),
      toolDirectory,
      platform,
      beforeInstall: dependencies.beforeInstall,
      beforeCommit: dependencies.beforeCommit,
      syncDirectory: dependencies.syncDirectory,
    });
    return 0;
  } finally {
    assertTemporaryDirectoryIdentity(targetDirectory, targetIdentity);
    removeTemporaryDirectory(targetDirectory, targetIdentity);
  }
}

if (import.meta.main) {
  const action = Bun.argv[2];
  if (
    (action !== "check" && action !== "build")
    || Bun.argv.length !== 3
  ) {
    process.stderr.write("usage: runner.ts check|build\n");
    process.exit(2);
  }
  try {
    process.exit(runMetadataSearchTool(action));
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    process.stderr.write(`metadata-search tool ${action} failed: ${message}\n`);
    process.exit(1);
  }
}
