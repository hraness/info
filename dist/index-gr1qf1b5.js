// @bun
import {
  MAX_SEARCH_RESULTS,
  openKnowledgeBase
} from "./index-1qtgx1er.js";
import {
  scanVault
} from "./index-b4vcr4gt.js";
import {
  MAX_EVALUATION_EVIDENCE_BYTES,
  redactEvaluationMachinePaths
} from "./index-b88v3vtm.js";
import {
  runGitCommand
} from "./index-1gwbassd.js";
import {
  MAX_REPOSITORY_MEMORY_DETAIL_LIMIT,
  MAX_REPOSITORY_MEMORY_GROUP_LIMIT,
  buildRepositoryMemoryContext,
  repositoryMemoryGroupKeys
} from "./index-06c9ctr6.js";
import {
  inspectAgentContextRepository
} from "./index-5vwpzb5a.js";

// src/evaluation-kb.ts
import { realpath, stat } from "fs/promises";
import { isAbsolute, relative, resolve, sep } from "path";
var objectIdPattern = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
var SNAPSHOT_GIT_TIMEOUT_MS = 1e4;
var SNAPSHOT_GIT_OUTPUT_BYTES = 64 * 1024;
var DIAGNOSTIC_MESSAGE_BYTES = 16 * 1024;
var knowledgeBaseEvaluationRetrieverIds = Object.freeze([
  "exact",
  "keyword",
  "semantic",
  "hybrid",
  "metadata",
  "graph",
  "path-context",
  "git"
]);

class FrozenEvaluationSnapshotError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "FrozenEvaluationSnapshotError";
  }
}
function pathIsWithin(root, candidate) {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" || fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}
function decodedOutput(output, label, maximumBytes = SNAPSHOT_GIT_OUTPUT_BYTES) {
  const bytes = typeof output === "string" ? Buffer.from(output, "utf8") : Buffer.from(output);
  if (bytes.byteLength > maximumBytes) {
    throw new FrozenEvaluationSnapshotError(`${label} exceeded the ${maximumBytes.toLocaleString("en-US")}-byte output limit.`);
  }
  return bytes.toString("utf8");
}
async function gitOutput(runGit, repository, args, label) {
  const result = await runGit({
    arguments: args,
    cwd: repository,
    timeoutMs: SNAPSHOT_GIT_TIMEOUT_MS,
    maxOutputBytes: SNAPSHOT_GIT_OUTPUT_BYTES
  });
  if (result.status !== "ok") {
    throw new FrozenEvaluationSnapshotError(`${label} could not be verified: ${result.status === "unavailable" ? result.message : result.message}`);
  }
  return decodedOutput(result.stdout, label);
}
function gitObjectId(output, label) {
  const value = output.trim();
  if (!objectIdPattern.test(value)) {
    throw new FrozenEvaluationSnapshotError(`${label} returned a malformed Git object ID.`);
  }
  return value;
}
async function verifyFrozenEvaluationSnapshot(options) {
  const resolveRealpath = options.realpath ?? realpath;
  const readStat = options.stat ?? stat;
  const repository = await resolveRealpath(resolve(options.repository));
  const repositoryState = await readStat(repository);
  if (!repositoryState.isDirectory()) {
    throw new FrozenEvaluationSnapshotError("The evaluation repository must be a directory.");
  }
  const root = await resolveRealpath(resolve(options.root));
  const rootState = await readStat(root);
  if (!rootState.isDirectory()) {
    throw new FrozenEvaluationSnapshotError("The evaluation vault root must be a directory.");
  }
  if (!pathIsWithin(repository, root)) {
    throw new FrozenEvaluationSnapshotError("The evaluation vault root must resolve inside the repository.");
  }
  const declaredRoot = await resolveRealpath(resolve(repository, options.corpus.frozen.vaultRoot));
  if (!pathIsWithin(repository, declaredRoot) || declaredRoot !== root) {
    throw new FrozenEvaluationSnapshotError("The evaluation vault root must resolve to frozen.vaultRoot inside the repository.");
  }
  const runGit = options.runGit ?? runGitCommand;
  const repositoryPrefix = (await gitOutput(runGit, repository, ["rev-parse", "--show-prefix"], "Git repository root")).trim();
  if (repositoryPrefix !== "") {
    throw new FrozenEvaluationSnapshotError(`The evaluation repository must be the Git working-tree root; Git reported prefix ${JSON.stringify(repositoryPrefix)}.`);
  }
  const head = gitObjectId(await gitOutput(runGit, repository, ["rev-parse", "--verify", "HEAD"], "Git HEAD"), "Git HEAD");
  if (head !== options.corpus.frozen.repositoryCommit) {
    throw new FrozenEvaluationSnapshotError(`Frozen repository commit ${options.corpus.frozen.repositoryCommit} does not match HEAD ${head}.`);
  }
  const vaultRevision = options.corpus.frozen.vaultRoot === "." ? "HEAD^{tree}" : `HEAD:${options.corpus.frozen.vaultRoot}`;
  const vaultTree = gitObjectId(await gitOutput(runGit, repository, ["rev-parse", "--verify", vaultRevision], "Git vault tree"), "Git vault tree");
  if (vaultTree !== options.corpus.frozen.vaultTree) {
    throw new FrozenEvaluationSnapshotError(`Frozen vault tree ${options.corpus.frozen.vaultTree} does not match ${vaultRevision} ${vaultTree}.`);
  }
  const objectType = (await gitOutput(runGit, repository, ["cat-file", "-t", vaultRevision], "Git vault object type")).trim();
  if (objectType !== "tree") {
    throw new FrozenEvaluationSnapshotError(`${vaultRevision} must identify a Git tree, but Git reported ${JSON.stringify(objectType)}.`);
  }
  const status = await gitOutput(runGit, repository, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--",
    options.corpus.frozen.vaultRoot
  ], "Git vault status");
  if (status.trim() !== "") {
    const firstChange = status.trim().split(/\r?\n/u)[0] ?? "unknown vault change";
    throw new FrozenEvaluationSnapshotError(`The frozen evaluation vault has tracked or untracked changes: ${firstChange}.`);
  }
  return Object.freeze({
    repository,
    root,
    vaultRoot: options.corpus.frozen.vaultRoot,
    repositoryCommit: head,
    vaultTree
  });
}
function elapsed(startedAt, now) {
  const duration = now() - startedAt;
  return Number.isFinite(duration) && duration > 0 ? duration : 0;
}
function utf8Prefix(value, maximumBytes) {
  let bytes = 0;
  let end = 0;
  for (const character of value) {
    const width = Buffer.byteLength(character, "utf8");
    if (bytes + width > maximumBytes)
      break;
    bytes += width;
    end += character.length;
  }
  return value.slice(0, end);
}
function diagnosticMessage(parts) {
  const joined = redactEvaluationMachinePaths(parts.join(" ").normalize("NFC").replace(/[\0\r\n]+/gu, " ").trim());
  if (joined === "")
    return;
  return utf8Prefix(joined, DIAGNOSTIC_MESSAGE_BYTES);
}
function evidenceSnapshot(value) {
  const serialized = JSON.stringify(value, (_key, candidate) => typeof candidate === "string" ? redactEvaluationMachinePaths(candidate) : candidate);
  if (serialized === undefined)
    return null;
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes <= MAX_EVALUATION_EVIDENCE_BYTES) {
    return JSON.parse(serialized);
  }
  let prefixBytes = MAX_EVALUATION_EVIDENCE_BYTES - 1024;
  while (prefixBytes > 0) {
    const snapshot = {
      truncated: true,
      originalUtf8Bytes: bytes,
      jsonPrefix: utf8Prefix(serialized, prefixBytes)
    };
    if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") <= MAX_EVALUATION_EVIDENCE_BYTES) {
      return snapshot;
    }
    prefixBytes = Math.floor(prefixBytes * 0.75);
  }
  return { truncated: true, originalUtf8Bytes: bytes, jsonPrefix: "" };
}
function unavailable(id, requiredInput, noteCount) {
  return Object.freeze({
    status: "unavailable",
    hits: Object.freeze([]),
    diagnostics: Object.freeze([Object.freeze({
      lane: id,
      status: "unavailable",
      message: `${id} retrieval requires ${requiredInput}.`
    })]),
    timings: Object.freeze({}),
    resources: Object.freeze({ noteCount })
  });
}
function statusFromDiagnostics(diagnostics, hits) {
  if (hits.length === 0 && diagnostics.length > 0 && diagnostics.every(({ status }) => status === "unavailable"))
    return "unavailable";
  return diagnostics.some(({ status }) => status !== "ready") ? "degraded" : "ready";
}
function textResult(result) {
  const hits = Object.freeze(result.results.map((hit) => Object.freeze({
    documentId: hit.id,
    rank: hit.rank,
    score: hit.score,
    evidence: evidenceSnapshot({
      mode: result.mode,
      path: hit.path,
      title: hit.title,
      identity: hit.identity,
      ...hit.line === undefined ? {} : { line: hit.line },
      snippet: hit.snippet,
      evidence: hit.evidence,
      contributions: hit.contributions
    })
  })));
  const diagnostics = Object.freeze(result.diagnostics.lanes.map((lane) => Object.freeze({
    lane: lane.lane,
    status: lane.status,
    ...lane.message === undefined ? {} : { message: diagnosticMessage([lane.message]) ?? "Search diagnostic unavailable." }
  })));
  const laneResults = new Map(result.diagnostics.lanes.map(({ lane, results }) => [lane, results]));
  return Object.freeze({
    status: statusFromDiagnostics(diagnostics, hits),
    hits,
    diagnostics,
    timings: Object.freeze({ searchMs: result.diagnostics.elapsedMs }),
    resources: Object.freeze({
      noteCount: result.diagnostics.notes,
      resultCount: result.results.length,
      partial: Number(result.partial),
      exactResultCount: laneResults.get("exact") ?? 0,
      qmdResultCount: laneResults.get("qmd") ?? 0
    })
  });
}
function stableHits(candidates, limit) {
  const unique = new Map;
  for (const candidate of candidates) {
    if (!unique.has(candidate.documentId))
      unique.set(candidate.documentId, candidate);
  }
  return Object.freeze([...unique.values()].slice(0, limit).map((candidate, index) => Object.freeze({
    documentId: candidate.documentId,
    rank: index + 1,
    ...candidate.score === undefined ? {} : { score: candidate.score },
    evidence: evidenceSnapshot(candidate.evidence)
  })));
}
function metadataRetriever(session, now) {
  return Object.freeze({
    id: "metadata",
    retrieve: ({ query, limit, signal }) => {
      if (query.inputs.metadata === undefined) {
        return Promise.resolve(unavailable("metadata", "query.inputs.metadata", session.noteCount));
      }
      throwIfAborted(signal);
      const startedAt = now();
      const rows = session.list({
        filters: query.inputs.metadata.filters,
        tags: query.inputs.metadata.tags,
        limit
      });
      throwIfAborted(signal);
      const hits = Object.freeze(rows.map((row, index) => Object.freeze({
        documentId: row.id,
        rank: index + 1,
        evidence: evidenceSnapshot(row)
      })));
      return Promise.resolve(Object.freeze({
        status: "ready",
        hits,
        diagnostics: Object.freeze([Object.freeze({
          lane: "metadata",
          status: "ready"
        })]),
        timings: Object.freeze({ listMs: elapsed(startedAt, now) }),
        resources: Object.freeze({ noteCount: session.noteCount, resultCount: rows.length })
      }));
    }
  });
}
function graphRetriever(session, now) {
  return Object.freeze({
    id: "graph",
    retrieve: ({ query, limit, signal }) => {
      const input = query.inputs.graph;
      if (input === undefined) {
        return Promise.resolve(unavailable("graph", "query.inputs.graph", session.noteCount));
      }
      throwIfAborted(signal);
      const startedAt = now();
      const matches = new Map;
      const diagnostics = [];
      let edges = 0;
      let relations = 0;
      for (const [seedIndex, seed] of input.seeds.entries()) {
        const neighborhood = session.links(seed, {
          direction: "both",
          depth: input.depth,
          limit
        });
        edges += neighborhood.edges.length;
        relations += neighborhood.relations.length;
        diagnostics.push(Object.freeze({
          lane: "graph",
          status: neighborhood.truncated ? "degraded" : "ready",
          ...neighborhood.truncated ? { message: `Graph traversal from ${JSON.stringify(seed)} reached its result limit.` } : {}
        }));
        for (const [nodeIndex, node] of neighborhood.nodes.entries()) {
          const raw = { seed, node, edges: neighborhood.edges, relations: neighborhood.relations };
          const existing = matches.get(node.id);
          if (existing === undefined) {
            matches.set(node.id, {
              documentId: node.id,
              distance: node.distance,
              seedIndex,
              nodeIndex,
              evidence: [raw]
            });
          } else {
            existing.evidence.push(raw);
          }
        }
      }
      const candidates = [...matches.values()].toSorted((left, right) => left.distance - right.distance || left.seedIndex - right.seedIndex || left.nodeIndex - right.nodeIndex || left.documentId.localeCompare(right.documentId));
      const hits = stableHits(candidates.map((candidate) => ({
        documentId: candidate.documentId,
        score: 1 / (candidate.distance + 1),
        evidence: { neighborhoods: candidate.evidence }
      })), limit);
      throwIfAborted(signal);
      return Promise.resolve(Object.freeze({
        status: statusFromDiagnostics(diagnostics, hits),
        hits,
        diagnostics: Object.freeze(diagnostics),
        timings: Object.freeze({ linksMs: elapsed(startedAt, now) }),
        resources: Object.freeze({
          noteCount: session.noteCount,
          seedCount: input.seeds.length,
          resultCount: hits.length,
          edgeCount: edges,
          relationCount: relations
        })
      }));
    }
  });
}
function pathContextDiagnostics(inspection, memory) {
  const inspectionMessage = diagnosticMessage(inspection.issues.map(({ message }) => message));
  const memoryMessages = [
    ...memory.invalidRecords.details.flatMap(({ issues }) => issues),
    ...memory.advisories.details.map(({ message }) => message),
    ...repositoryMemoryGroupKeys.some((key) => memory.groups[key].truncated) ? ["Repository-memory results were truncated by the evaluation limit."] : []
  ];
  const memoryMessage = diagnosticMessage(memoryMessages);
  return Object.freeze([
    Object.freeze({
      lane: "agent-context",
      status: inspection.issues.length === 0 ? "ready" : "degraded",
      ...inspectionMessage === undefined ? {} : { message: inspectionMessage }
    }),
    Object.freeze({
      lane: "repository-memory",
      status: memoryMessages.length === 0 ? "ready" : "degraded",
      ...memoryMessage === undefined ? {} : { message: memoryMessage }
    })
  ]);
}
function pathContextRetriever(session, snapshot, repository, inspectContext, buildMemory, now) {
  return Object.freeze({
    id: "path-context",
    retrieve: async ({ query, limit, signal }) => {
      const input = query.inputs.context;
      if (input === undefined) {
        return unavailable("path-context", "query.inputs.context", session.noteCount);
      }
      throwIfAborted(signal);
      const inspectionStartedAt = now();
      const inspection = await inspectContext(snapshot.notes, {
        repositoryRoot: repository,
        target: input.repositoryPath,
        targetKind: "auto"
      });
      const inspectionMs = elapsed(inspectionStartedAt, now);
      throwIfAborted(signal);
      const memoryStartedAt = now();
      const memory = await buildMemory(snapshot.notes, {
        repositoryRoot: repository,
        target: input.repositoryPath,
        groupLimit: Math.min(limit, MAX_REPOSITORY_MEMORY_GROUP_LIMIT),
        detailLimit: Math.min(limit, MAX_REPOSITORY_MEMORY_DETAIL_LIMIT)
      });
      const memoryMs = elapsed(memoryStartedAt, now);
      throwIfAborted(signal);
      const candidates = [
        ...inspection.matchingContexts.map((hub) => ({
          documentId: hub.note.id,
          evidence: {
            kind: "agent-context",
            path: hub.note.path,
            rawScope: hub.rawScope,
            scope: hub.scope,
            canonicalId: hub.canonicalId,
            canonicalPath: hub.canonicalPath,
            guidePath: hub.guidePath,
            canonical: hub.canonical,
            reciprocal: hub.reciprocal,
            valid: hub.valid
          }
        })),
        ...repositoryMemoryGroupKeys.flatMap((group) => memory.groups[group].records.map((record) => ({
          documentId: record.id,
          evidence: { kind: "repository-memory", group, record }
        })))
      ];
      const hits = stableHits(candidates, limit);
      const diagnostics = pathContextDiagnostics(inspection, memory);
      return Object.freeze({
        status: statusFromDiagnostics(diagnostics, hits),
        hits,
        diagnostics,
        timings: Object.freeze({ inspectionMs, memoryMs }),
        resources: Object.freeze({
          noteCount: session.noteCount,
          resultCount: hits.length,
          matchingContextCount: inspection.matchingContexts.length,
          inheritedGuideCount: inspection.inheritedGuides.length,
          contextIssueCount: inspection.issues.length,
          memoryMatchedCount: memory.counts.matched,
          memoryReturnedCount: memory.counts.returned,
          memoryInvalidCount: memory.counts.invalid,
          memoryAdvisoryCount: memory.counts.advisories
        })
      });
    }
  });
}
function gitDiagnostic(lane, result) {
  if (result.status === "unavailable") {
    return Object.freeze({
      lane,
      status: "unavailable",
      message: diagnosticMessage([result.reason]) ?? "Git retrieval is unavailable."
    });
  }
  const limited = result.limitedCommits ?? [];
  return Object.freeze({
    lane,
    status: limited.length === 0 ? "ready" : "degraded",
    ...limited.length === 0 ? {} : { message: `${limited.length} oversized Git commit record(s) have limited evidence.` }
  });
}
function gitRetriever(session, frozenCommit, now) {
  return Object.freeze({
    id: "git",
    retrieve: async ({ query, limit, signal }) => {
      const input = query.inputs.history;
      if (input === undefined) {
        return unavailable("git", "query.inputs.history", session.noteCount);
      }
      throwIfAborted(signal);
      const searchStartedAt = now();
      const searched = await session.searchHistory({
        query: input.query,
        limit: Math.min(limit, 100)
      });
      const searchMs = elapsed(searchStartedAt, now);
      throwIfAborted(signal);
      const historyStartedAt = now();
      const history = await session.history(input.noteIds);
      const historyMs = elapsed(historyStartedAt, now);
      throwIfAborted(signal);
      for (const result of [searched, history]) {
        if (result.status === "ready" && result.head !== frozenCommit) {
          throw new FrozenEvaluationSnapshotError(`Git retrieval observed HEAD ${result.head}, expected frozen commit ${frozenCommit}.`);
        }
      }
      const searchedById = new Map(searched.status === "ready" ? searched.hits.map((hit) => [hit.id, hit]) : []);
      const historyById = new Map(history.status === "ready" ? history.notes.map((note) => [note.id, note]) : []);
      const orderedIds = [
        ...input.noteIds.filter((id) => historyById.has(id)),
        ...searched.status === "ready" ? searched.hits.map(({ id }) => id) : []
      ];
      const candidates = orderedIds.map((documentId) => {
        const searchedHit = searchedById.get(documentId);
        const provenance = historyById.get(documentId);
        return {
          documentId,
          ...searchedHit === undefined ? {} : { score: searchedHit.score },
          evidence: {
            ...provenance === undefined ? {} : { history: provenance },
            ...searchedHit === undefined ? {} : { search: searchedHit }
          }
        };
      });
      const hits = stableHits(candidates, limit);
      const diagnostics = Object.freeze([
        gitDiagnostic("git-search", searched),
        gitDiagnostic("git-history", history)
      ]);
      const searchedLimited = searched.status === "ready" ? searched.limitedCommits?.length ?? 0 : 0;
      const historyLimited = history.status === "ready" ? history.limitedCommits?.length ?? 0 : 0;
      return Object.freeze({
        status: statusFromDiagnostics(diagnostics, hits),
        hits,
        diagnostics,
        timings: Object.freeze({ searchHistoryMs: searchMs, historyMs }),
        resources: Object.freeze({
          noteCount: session.noteCount,
          resultCount: hits.length,
          searchResultCount: searched.status === "ready" ? searched.hits.length : 0,
          historyResultCount: history.status === "ready" ? history.notes.length : 0,
          limitedCommitCount: searchedLimited + historyLimited
        })
      });
    }
  });
}
function throwIfAborted(signal) {
  if (!signal.aborted)
    return;
  if (signal.reason instanceof Error)
    throw signal.reason;
  throw new Error("Knowledge-base evaluation retrieval was aborted.");
}
function textRetriever(id, session) {
  return Object.freeze({
    id,
    retrieve: async ({ query, limit, signal }) => {
      const text = query.inputs.text;
      if (text === undefined)
        return unavailable(id, "query.inputs.text", session.noteCount);
      throwIfAborted(signal);
      const result = await session.search({
        query: text,
        mode: id,
        limit: Math.min(limit, MAX_SEARCH_RESULTS),
        graph: false,
        history: false
      });
      throwIfAborted(signal);
      return textResult(result);
    }
  });
}
function knowledgeBaseDependencies(options, snapshot) {
  const git = options.git === undefined && options.runGit === undefined ? undefined : {
    ...options.git,
    ...options.git?.runGit !== undefined || options.runGit === undefined ? {} : { runGit: options.runGit }
  };
  return {
    scanVault: () => Promise.resolve(snapshot),
    ...options.semantic === undefined ? {} : { semantic: options.semantic },
    ...options.openSemanticSearchSession === undefined ? {} : { openSemanticSearchSession: options.openSemanticSearchSession },
    ...git === undefined ? {} : { git },
    ...options.indexGitHistory === undefined ? {} : { indexGitHistory: options.indexGitHistory }
  };
}
async function openKnowledgeBaseEvaluation(options) {
  const verified = await verifyFrozenEvaluationSnapshot(options);
  const scanner = options.scanVault ?? scanVault;
  const snapshot = await scanner(verified.root, { mentionScope: false });
  const open = options.openKnowledgeBase ?? openKnowledgeBase;
  const session = await open({
    root: verified.root,
    repository: verified.repository,
    ...options.database === undefined ? {} : { database: options.database },
    ...options.embeddingModelFile === undefined ? {} : { embeddingModelFile: options.embeddingModelFile }
  }, knowledgeBaseDependencies(options, snapshot));
  const now = options.now ?? performance.now.bind(performance);
  const inspectContext = options.inspectAgentContextRepository ?? inspectAgentContextRepository;
  const buildMemory = options.buildRepositoryMemoryContext ?? buildRepositoryMemoryContext;
  const retrievers = Object.freeze([
    textRetriever("exact", session),
    textRetriever("keyword", session),
    textRetriever("semantic", session),
    textRetriever("hybrid", session),
    metadataRetriever(session, now),
    graphRetriever(session, now),
    pathContextRetriever(session, snapshot, verified.repository, inspectContext, buildMemory, now),
    gitRetriever(session, verified.repositoryCommit, now)
  ]);
  return Object.freeze({ retrievers, close: session.close });
}

export { knowledgeBaseEvaluationRetrieverIds, FrozenEvaluationSnapshotError, verifyFrozenEvaluationSnapshot, openKnowledgeBaseEvaluation };
