// @bun
import {
  openSemanticSearchSession,
  recommendedEmbeddingModel,
  scanVault
} from "./index-hfdajx5y.js";
import {
  GitHistoryError,
  gitHistoryForNotes,
  indexGitHistory,
  searchGitHistory
} from "./index-tb103fj6.js";
import {
  buildGraphContext,
  fuseRankedCandidates,
  searchExactVault
} from "./index-rn4d2mpa.js";
import {
  NavigationBudgetError,
  navigateLinks
} from "./index-d13v9ckt.js";
import {
  queryVault
} from "./index-m4bexhht.js";
import {
  lookupNote
} from "./index-4962kvds.js";

// src/sdk.ts
var MAX_SEARCH_RESULTS = 100;
var MAX_READ_BYTES = 64 * 1024;
var DEFAULT_CONTEXT_BYTES = 24 * 1024;
var MAX_CONTEXT_BYTES = 64 * 1024;
function checkedLimit(value, fallback, maximum, label) {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) {
    throw new RangeError(`${label} must be an integer from 1 through ${maximum}.`);
  }
  return limit;
}
function noteOrThrow(notes, query) {
  const result = lookupNote(notes, query);
  if (result.kind === "found")
    return result.note;
  if (result.kind === "ambiguous") {
    throw new Error(`Knowledge-base note ${JSON.stringify(query)} is ambiguous: ` + result.candidates.map(({ path }) => path).join(", "));
  }
  throw new Error(`Knowledge-base note ${JSON.stringify(query)} was not found.`);
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
function utf8Prefix(value, maximumBytes) {
  if (Buffer.byteLength(value) <= maximumBytes)
    return { value, truncated: false };
  let bytes = 0;
  let prefix = "";
  for (const character of value) {
    const width = Buffer.byteLength(character);
    if (bytes + width > maximumBytes)
      break;
    prefix += character;
    bytes += width;
  }
  return { value: prefix, truncated: true };
}
function unavailableHistory(root, reason) {
  return {
    status: "unavailable",
    repository: "",
    root,
    vaultPrefix: "",
    reason
  };
}
function qmdMode(mode) {
  return mode === "exact" ? null : mode;
}
function checkedSearchMode(value) {
  const mode = value ?? "hybrid";
  if (mode !== "exact" && mode !== "hybrid" && mode !== "keyword" && mode !== "semantic") {
    throw new Error('Knowledge-base search mode must be "exact", "hybrid", "keyword", or "semantic".');
  }
  return mode;
}
function checkedHistoryRequest(value) {
  if (value === false)
    return { enabled: false };
  if (value === undefined || value === "auto") {
    return { enabled: true, required: false, options: {} };
  }
  if (value === "required") {
    return { enabled: true, required: true, options: {} };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error('Search history must be false, "auto", "required", or an options object.');
  }
  const options = value;
  if (options.policy !== undefined && options.policy !== "auto" && options.policy !== "required") {
    throw new Error('Search history policy must be "auto" or "required".');
  }
  return {
    enabled: true,
    required: options.policy === "required",
    options
  };
}
async function openKnowledgeBase(options, dependencies = {}) {
  const snapshot = await (dependencies.scanVault ?? scanVault)(options.root, { ...options.scan ?? {}, mentionScope: false });
  const notesById = new Map(snapshot.notes.map((note) => [note.id, note]));
  const notesByPath = new Map(snapshot.notes.map((note) => [note.path, note]));
  let closeRequested = false;
  let closePromise;
  let semanticPromise;
  let gitPromise;
  const assertOpen = () => {
    if (closeRequested)
      throw new Error("Knowledge-base session is closed.");
  };
  const semantic = () => {
    assertOpen();
    semanticPromise ??= (dependencies.openSemanticSearchSession ?? openSemanticSearchSession)({
      root: snapshot.root,
      ...options.database === undefined ? {} : { database: options.database }
    }, {
      ...dependencies.semantic ?? {},
      scanVault: () => Promise.resolve(snapshot)
    });
    return semanticPromise;
  };
  const gitIndex = () => {
    assertOpen();
    if (options.repository === undefined) {
      return Promise.resolve(unavailableHistory(snapshot.root, "No repository root was configured for this knowledge-base session."));
    }
    gitPromise ??= (dependencies.indexGitHistory ?? indexGitHistory)({
      repository: options.repository,
      root: snapshot.root,
      notes: snapshot.notes
    }, dependencies.git);
    return gitPromise;
  };
  const grep = (grepOptions) => {
    assertOpen();
    return searchExactVault(snapshot.notes, snapshot.analysis, grepOptions);
  };
  const list = (queryOptions = {}) => {
    assertOpen();
    return queryVault(snapshot.notes, snapshot.analysis, queryOptions);
  };
  const read = (query, readOptions = {}) => {
    assertOpen();
    const maximumBytes = checkedLimit(readOptions.maxBytes, MAX_READ_BYTES, MAX_READ_BYTES, "Read byte limit");
    const note = noteOrThrow(snapshot.notes, query);
    const content = utf8Prefix(note.content, maximumBytes);
    return {
      id: note.id,
      path: note.path,
      title: note.title,
      content: content.value,
      truncated: content.truncated
    };
  };
  const links = (query, linkOptions = {}) => {
    assertOpen();
    return navigateLinks(snapshot.notes, snapshot.analysis, noteOrThrow(snapshot.notes, query), linkOptions);
  };
  const search = async (searchOptions) => {
    assertOpen();
    const startedAt = performance.now();
    const query = searchOptions.query.trim();
    if (query === "")
      throw new Error("Search query must not be empty.");
    const mode = checkedSearchMode(searchOptions.mode);
    if (searchOptions.minScore !== undefined && (!Number.isFinite(searchOptions.minScore) || searchOptions.minScore < 0 || searchOptions.minScore > 1)) {
      throw new RangeError("Search minimum score must be a number from 0 through 1.");
    }
    if (mode === "exact" && searchOptions.minScore !== undefined) {
      throw new Error("Search minimum score applies only to hybrid, keyword, or semantic mode.");
    }
    const limit = checkedLimit(searchOptions.limit, 10, MAX_SEARCH_RESULTS, "Search limit");
    const candidateLimit = checkedLimit(searchOptions.candidateLimit, Math.max(40, limit * 4), 500, "Search candidate limit");
    if (candidateLimit < limit) {
      throw new RangeError("Search candidate limit must be at least the result limit.");
    }
    const historyRequest = checkedHistoryRequest(searchOptions.history);
    const historyNoteLimit = historyRequest.enabled ? checkedLimit(historyRequest.options.noteLimit, 5, 20, "Git history note limit") : null;
    const historyIndexPromise = !historyRequest.enabled ? null : gitIndex().then((index) => ({ status: "indexed", index }), (error) => ({ status: "failed", error }));
    const allowedIds = new Set(queryVault(snapshot.notes, snapshot.analysis, {
      filters: searchOptions.filters ?? [],
      tags: searchOptions.tags ?? []
    }).map(({ id }) => id));
    const includeExact = mode === "hybrid" || mode === "exact";
    const exact = includeExact ? searchExactVault(snapshot.notes, snapshot.analysis, {
      query,
      filters: searchOptions.filters ?? [],
      tags: searchOptions.tags ?? [],
      limit: Math.min(500, candidateLimit)
    }) : [];
    const exactById = new Map(exact.map((hit, index) => [hit.id, { hit, rank: index + 1 }]));
    const semanticById = new Map;
    const diagnostics = includeExact ? [{ lane: "exact", status: "ready", results: exact.length }] : [];
    let model = null;
    const selectedQmdMode = qmdMode(mode);
    if (selectedQmdMode !== null) {
      try {
        const session = await semantic();
        model = session.model;
        const semanticLimit = Math.min(MAX_SEARCH_RESULTS, candidateLimit);
        const result = await session.search({
          query,
          mode: selectedQmdMode,
          limit: semanticLimit,
          candidateLimit,
          ...searchOptions.minScore === undefined ? {} : { minScore: searchOptions.minScore }
        });
        let acceptedRank = 0;
        for (const hit of result.results) {
          const note = notesByPath.get(hit.path);
          if (note === undefined || !allowedIds.has(note.id) || semanticById.has(note.id))
            continue;
          acceptedRank += 1;
          semanticById.set(note.id, { hit, rank: acceptedRank });
        }
        const embeddingFailures = result.embedding?.failures?.length ?? 0;
        const embeddingErrors = result.embedding?.errors ?? 0;
        const embeddingDegraded = embeddingErrors > 0 || embeddingFailures > 0;
        diagnostics.push({
          lane: "qmd",
          status: embeddingDegraded ? "degraded" : "ready",
          results: semanticById.size,
          ...embeddingDegraded ? {
            message: `QMD embedding reported ${embeddingErrors} error(s)` + ` and ${embeddingFailures} retained failure record(s).`
          } : {}
        });
      } catch (error) {
        diagnostics.push({
          lane: "qmd",
          status: "unavailable",
          results: 0,
          message: errorMessage(error)
        });
      }
    }
    const lanes = [
      ...includeExact ? [{ name: "exact", weight: 2, ids: exact.map(({ id }) => id) }] : [],
      ...selectedQmdMode === null ? [] : [{ name: "qmd", weight: 1, ids: [...semanticById.keys()] }]
    ];
    const fused = fuseRankedCandidates(lanes);
    const ordered = fused.toSorted((left, right) => Number(exactById.get(right.id)?.hit.identity ?? false) - Number(exactById.get(left.id)?.hit.identity ?? false) || left.rank - right.rank || left.id.localeCompare(right.id));
    const results = ordered.slice(0, limit).map((candidate, index) => {
      const note = notesById.get(candidate.id);
      if (note === undefined) {
        throw new Error(`Fused retrieval returned unknown note ${JSON.stringify(candidate.id)}.`);
      }
      const exactMatch = exactById.get(candidate.id);
      const semanticMatch = semanticById.get(candidate.id);
      const evidence = [];
      if (exactMatch !== undefined) {
        evidence.push({
          kind: "exact",
          rank: exactMatch.rank,
          identity: exactMatch.hit.identity,
          matches: exactMatch.hit.matches
        });
      }
      if (semanticMatch !== undefined) {
        evidence.push({
          kind: "qmd",
          rank: semanticMatch.rank,
          source: semanticMatch.hit.source,
          score: semanticMatch.hit.score,
          ...semanticMatch.hit.signals === undefined ? {} : { signals: semanticMatch.hit.signals }
        });
      }
      const snippetSource = exactMatch?.hit.identity === true || semanticMatch === undefined ? exactMatch?.hit : semanticMatch.hit;
      return {
        id: note.id,
        path: note.path,
        title: note.title,
        rank: index + 1,
        score: candidate.score,
        identity: exactMatch?.hit.identity ?? false,
        ...snippetSource?.line === undefined ? {} : { line: snippetSource.line },
        snippet: snippetSource?.snippet ?? note.summary,
        tags: note.tags,
        metadata: note.metadata,
        evidence,
        contributions: candidate.contributions
      };
    });
    const graphOptions = searchOptions.graph === false ? null : searchOptions.graph ?? {};
    const explicitSeeds = graphOptions?.related ?? [];
    if (explicitSeeds.length > 5) {
      throw new RangeError("Hybrid search accepts at most 5 explicit related-note seeds.");
    }
    let graph = null;
    if (graphOptions !== null) {
      try {
        graph = buildGraphContext(snapshot.notes, snapshot.analysis, {
          seeds: [...explicitSeeds, ...results.slice(0, 5).map(({ id }) => id)],
          primaryIds: results.map(({ id }) => id),
          ...graphOptions.depth === undefined ? {} : { depth: graphOptions.depth },
          ...graphOptions.neighborsPerSeed === undefined ? {} : { neighborsPerSeed: graphOptions.neighborsPerSeed },
          ...graphOptions.limit === undefined ? {} : { limit: graphOptions.limit }
        });
        diagnostics.push({
          lane: "graph",
          status: "ready",
          results: graph.related.length
        });
      } catch (error) {
        if (!(error instanceof NavigationBudgetError))
          throw error;
        diagnostics.push({
          lane: "graph",
          status: "unavailable",
          results: 0,
          message: error.message
        });
      }
    }
    let history = null;
    if (historyRequest.enabled && historyIndexPromise !== null && historyNoteLimit !== null) {
      const outcome = await historyIndexPromise;
      let index;
      if (outcome.status === "failed") {
        if (historyRequest.required)
          throw outcome.error;
        index = unavailableHistory(snapshot.root, errorMessage(outcome.error));
      } else {
        index = outcome.index;
      }
      if (historyRequest.required && index.status === "unavailable") {
        throw new GitHistoryError("unavailable", `Required Git history is unavailable: ${index.reason}`);
      }
      history = gitHistoryForNotes(index, results.slice(0, historyNoteLimit).map(({ id }) => id), {
        ...historyRequest.options.commitsPerNote === undefined ? {} : { commitsPerNote: historyRequest.options.commitsPerNote },
        ...historyRequest.options.cochangedPathsPerCommit === undefined ? {} : {
          cochangedPathsPerCommit: historyRequest.options.cochangedPathsPerCommit
        }
      });
      diagnostics.push(history.status === "ready" ? {
        lane: "git",
        status: "ready",
        results: history.notes.length
      } : {
        lane: "git",
        status: "unavailable",
        results: 0,
        message: history.reason
      });
    }
    return {
      query,
      mode,
      results,
      graph,
      history,
      partial: diagnostics.some(({ status }) => status !== "ready"),
      diagnostics: {
        notes: snapshot.notes.length,
        model: selectedQmdMode === null ? null : model ?? recommendedEmbeddingModel,
        elapsedMs: performance.now() - startedAt,
        lanes: diagnostics
      }
    };
  };
  return {
    root: snapshot.root,
    ...options.repository === undefined ? {} : { repository: options.repository },
    noteCount: snapshot.notes.length,
    grep,
    list,
    read,
    links,
    backlinks: (query, linkOptions = {}) => links(query, {
      ...linkOptions,
      direction: "in"
    }),
    search,
    history: async (noteIds, historyOptions = {}) => {
      assertOpen();
      return gitHistoryForNotes(await gitIndex(), noteIds, historyOptions);
    },
    searchHistory: async (historyOptions) => {
      assertOpen();
      return searchGitHistory(await gitIndex(), historyOptions);
    },
    close: () => {
      if (closePromise !== undefined)
        return closePromise;
      closeRequested = true;
      closePromise = semanticPromise === undefined ? Promise.resolve() : semanticPromise.then((session) => session.close(), () => {
        return;
      });
      return closePromise;
    }
  };
}
function packSearchContext(result, options = {}) {
  const maximumBytes = checkedLimit(options.maxBytes, DEFAULT_CONTEXT_BYTES, MAX_CONTEXT_BYTES, "Context byte limit");
  const sections = [
    `# Knowledge-base context

Query: ${result.query}
Mode: ${result.mode}
`,
    ...result.results.map((hit) => [
      `## ${hit.rank}. ${hit.title}`,
      `Path: ${hit.path}${hit.line === undefined ? "" : `:${hit.line}`}`,
      `Evidence: ${hit.evidence.map((item) => `${item.kind}#${item.rank}`).join(", ")}`,
      hit.snippet
    ].join(`

`)),
    ...result.graph?.related.length === 0 || result.graph === null ? [] : [
      `## Related graph context

` + result.graph.related.map((hit) => `- ${hit.path} (${hit.evidence.map(({ kind }) => kind).join(", ")})`).join(`
`)
    ],
    ...result.history?.status !== "ready" ? [] : [
      `## Git provenance

` + result.history.notes.flatMap((note) => note.commits.map((commit) => `- ${note.path}: ${commit.committedAt} ${commit.hash.slice(0, 12)} ${commit.subject}`)).join(`
`)
    ]
  ];
  const packed = utf8Prefix(`${sections.join(`

`)}
`, maximumBytes);
  return { content: packed.value, truncated: packed.truncated };
}

export { openKnowledgeBase, packSearchContext };
