// @bun
import {
  openSemanticSearchSession,
  recommendedEmbeddingModel,
  scanVault
} from "./index-6m6y70a2.js";
import {
  GitHistoryError,
  gitHistoryForNotes,
  indexGitHistory,
  searchGitHistory,
  validateGitHistoryForNotesOptions,
  validateGitHistoryForNotesRequest,
  validateSearchGitHistoryOptions
} from "./index-1gwbassd.js";
import {
  buildGraphContext,
  fuseRankedCandidates,
  searchExactVault,
  validateSearchQuery
} from "./index-ahw5amhf.js";
import {
  NavigationBudgetError,
  navigateLinks
} from "./index-d13v9ckt.js";
import {
  queryVault
} from "./index-7gsmq0jt.js";
import {
  lookupNote
} from "./index-4962kvds.js";

// src/sdk.ts
var MAX_SEARCH_RESULTS = 100;
var MAX_SEARCH_CANDIDATES = 500;
var DEFAULT_SEARCH_RESULTS = 10;
var MAX_READ_BYTES = 64 * 1024;
var DEFAULT_CONTEXT_BYTES = 24 * 1024;
var MAX_CONTEXT_BYTES = 64 * 1024;
var DEFAULT_SEARCH_HISTORY_NOTES = 5;
var MAX_SEARCH_HISTORY_NOTES = 20;
var MAX_SEARCH_RELATED_SEEDS = 5;
var MAX_SEARCH_NOTE_REFERENCE_BYTES = 16 * 1024;
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
  let bytes = 0;
  let end = 0;
  for (const character of value) {
    const width = Buffer.byteLength(character, "utf8");
    if (bytes + width > maximumBytes) {
      return { value: value.slice(0, end), truncated: true, bytes };
    }
    bytes += width;
    end += character.length;
  }
  return { value, truncated: false, bytes };
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
function limitedHistoryMessage(commits) {
  const count = commits.length;
  const limit = commits[0]?.pathLimit ?? 0;
  return `${count} Git commit${count === 1 ? "" : "s"} exceeded the ${limit.toLocaleString("en-US")} changed-path detail limit; co-change evidence is incomplete.`;
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
function checkedGraphOptions(value) {
  if (value === false)
    return null;
  if (value !== undefined && (typeof value !== "object" || value === null || Array.isArray(value))) {
    throw new TypeError("Search graph options must be false or an options object.");
  }
  const options = value ?? {};
  const related = options.related ?? [];
  if (!Array.isArray(related)) {
    throw new TypeError("Search related-note seeds must be an array.");
  }
  if (related.length > MAX_SEARCH_RELATED_SEEDS) {
    throw new RangeError(`Hybrid search accepts at most ${MAX_SEARCH_RELATED_SEEDS} explicit related-note seeds.`);
  }
  const checkedRelated = [];
  for (const [index, seed] of related.entries()) {
    if (typeof seed !== "string") {
      throw new TypeError(`Search related-note seed ${index + 1} must be a string.`);
    }
    if (seed.trim() === "") {
      throw new TypeError(`Search related-note seed ${index + 1} must not be empty.`);
    }
    if (Buffer.byteLength(seed, "utf8") > MAX_SEARCH_NOTE_REFERENCE_BYTES) {
      throw new RangeError(`Search related-note seed ${index + 1} must be at most ` + `${MAX_SEARCH_NOTE_REFERENCE_BYTES.toLocaleString("en-US")} UTF-8 bytes.`);
    }
    checkedRelated.push(seed);
  }
  return Object.freeze({
    related: Object.freeze(checkedRelated),
    depth: checkedLimit(options.depth, 1, 2, "Graph context depth"),
    neighborsPerSeed: checkedLimit(options.neighborsPerSeed, 3, 20, "Graph neighbors per seed"),
    limit: checkedLimit(options.limit, 20, 100, "Graph context limit")
  });
}
function resolvedGraphSeeds(notes, seeds) {
  return seeds.map((seed) => {
    const lookup = lookupNote(notes, seed);
    if (lookup.kind === "missing") {
      throw new Error(`Graph context seed ${JSON.stringify(seed)} was not found.`);
    }
    if (lookup.kind === "ambiguous") {
      throw new Error(`Graph context seed ${JSON.stringify(seed)} is ambiguous: ` + lookup.candidates.map(({ path }) => path).join(", "));
    }
    return lookup.note.id;
  });
}
function checkedHistoryRequest(value) {
  if (value === undefined || value === false)
    return { enabled: false };
  let options;
  let required;
  if (value === "auto") {
    options = {};
    required = false;
  } else if (value === "required") {
    options = {};
    required = true;
  } else if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error('Search history must be false, "auto", "required", or an options object.');
  } else {
    options = value;
    if (options.policy !== undefined && options.policy !== "auto" && options.policy !== "required") {
      throw new Error('Search history policy must be "auto" or "required".');
    }
    required = options.policy === "required";
  }
  return {
    enabled: true,
    required,
    noteLimit: checkedLimit(options.noteLimit, DEFAULT_SEARCH_HISTORY_NOTES, MAX_SEARCH_HISTORY_NOTES, "Git history note limit"),
    options: validateGitHistoryForNotesOptions(options)
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
    const { query } = validateSearchQuery(searchOptions.query);
    const mode = checkedSearchMode(searchOptions.mode);
    const minScore = searchOptions.minScore;
    if (minScore !== undefined && (!Number.isFinite(minScore) || minScore < 0 || minScore > 1)) {
      throw new RangeError("Search minimum score must be a number from 0 through 1.");
    }
    if (mode === "exact" && minScore !== undefined) {
      throw new Error("Search minimum score applies only to hybrid, keyword, or semantic mode.");
    }
    const limit = checkedLimit(searchOptions.limit, DEFAULT_SEARCH_RESULTS, MAX_SEARCH_RESULTS, "Search limit");
    const filters = searchOptions.filters ?? [];
    const tags = searchOptions.tags ?? [];
    const filtered = filters.length > 0 || tags.length > 0;
    const candidateLimit = checkedLimit(searchOptions.candidateLimit, filtered ? MAX_SEARCH_CANDIDATES : Math.max(40, limit * 4), MAX_SEARCH_CANDIDATES, "Search candidate limit");
    if (candidateLimit < limit) {
      throw new RangeError("Search candidate limit must be at least the result limit.");
    }
    const historyRequest = checkedHistoryRequest(searchOptions.history);
    const graphOptions = checkedGraphOptions(searchOptions.graph);
    const explicitSeeds = graphOptions === null ? [] : resolvedGraphSeeds(snapshot.notes, graphOptions.related);
    const historyNoteLimit = historyRequest.enabled ? historyRequest.noteLimit : null;
    const allowedIds = new Set(queryVault(snapshot.notes, snapshot.analysis, {
      filters,
      tags
    }).map(({ id }) => id));
    const includeExact = mode === "hybrid" || mode === "exact";
    const exact = includeExact ? searchExactVault(snapshot.notes, snapshot.analysis, {
      query,
      filters,
      tags,
      limit: Math.min(MAX_SEARCH_CANDIDATES, candidateLimit)
    }) : [];
    const exactById = new Map(exact.map((hit, index) => [hit.id, { hit, rank: index + 1 }]));
    const semanticById = new Map;
    const diagnostics = includeExact ? [{ lane: "exact", status: "ready", results: exact.length }] : [];
    let model = null;
    const selectedQmdMode = qmdMode(mode);
    if (selectedQmdMode !== null) {
      if (allowedIds.size === 0) {
        diagnostics.push({ lane: "qmd", status: "ready", results: 0 });
      } else {
        try {
          const session = await semantic();
          model = session.model;
          const semanticLimit = candidateLimit;
          const result = await session.search({
            query,
            mode: selectedQmdMode,
            limit: semanticLimit,
            candidateLimit,
            ...minScore === undefined ? {} : { minScore }
          });
          let acceptedRank = 0;
          let discardedCandidates = result.rawWindow?.discarded ?? 0;
          for (const hit of result.results) {
            const note = notesByPath.get(hit.path);
            if (note === undefined || semanticById.has(note.id)) {
              discardedCandidates += 1;
              continue;
            }
            if (!allowedIds.has(note.id)) {
              discardedCandidates += 1;
              continue;
            }
            acceptedRank += 1;
            semanticById.set(note.id, { hit, rank: acceptedRank });
          }
          const embeddingFailures = result.embedding?.failures?.length ?? 0;
          const embeddingErrors = result.embedding?.errors ?? 0;
          const embeddingDegraded = embeddingErrors > 0 || embeddingFailures > 0;
          const requestedEligible = Math.min(limit, allowedIds.size);
          const incompleteCandidateWindow = discardedCandidates > 0 && semanticById.size < requestedEligible;
          const messages = [];
          if (embeddingDegraded) {
            messages.push(`QMD embedding reported ${embeddingErrors} error(s)` + ` and ${embeddingFailures} retained failure record(s).`);
          }
          if (incompleteCandidateWindow) {
            messages.push(`QMD's bounded ${semanticLimit}-candidate retrieval discarded ` + `${discardedCandidates} row(s) during live reconciliation or metadata filtering ` + `and accepted ${semanticById.size} of ${requestedEligible} eligible requested ` + "result(s); this bounded reconciliation cannot certify a complete eligible result set.");
          }
          diagnostics.push({
            lane: "qmd",
            status: embeddingDegraded || incompleteCandidateWindow ? "degraded" : "ready",
            results: semanticById.size,
            ...messages.length === 0 ? {} : { message: messages.join(" ") }
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
    }
    const lanes = [
      ...includeExact ? [{ name: "exact", weight: 1, ids: exact.map(({ id }) => id) }] : [],
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
    let graph = null;
    if (graphOptions !== null) {
      try {
        graph = buildGraphContext(snapshot.notes, snapshot.analysis, {
          seeds: [...explicitSeeds, ...results.slice(0, 5).map(({ id }) => id)],
          primaryIds: results.map(({ id }) => id),
          depth: graphOptions.depth,
          neighborsPerSeed: graphOptions.neighborsPerSeed,
          limit: graphOptions.limit
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
    if (historyRequest.enabled && historyNoteLimit !== null && results.length > 0) {
      const outcome = await gitIndex().then((index2) => ({ status: "indexed", index: index2 }), (error) => ({ status: "failed", error }));
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
      history = gitHistoryForNotes(index, results.slice(0, historyNoteLimit).map(({ id }) => id), historyRequest.options);
      const limitedCommits = history.status === "ready" ? history.limitedCommits ?? [] : [];
      if (historyRequest.required && limitedCommits.length > 0) {
        throw new GitHistoryError("budget", `Required Git history is incomplete: ${limitedHistoryMessage(limitedCommits)}`);
      }
      diagnostics.push(history.status === "ready" && limitedCommits.length === 0 ? {
        lane: "git",
        status: "ready",
        results: history.notes.length
      } : history.status === "ready" ? {
        lane: "git",
        status: "degraded",
        results: history.notes.length,
        message: limitedHistoryMessage(limitedCommits)
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
      const request = validateGitHistoryForNotesRequest(noteIds, historyOptions);
      return gitHistoryForNotes(await gitIndex(), request.noteIds, request.options);
    },
    searchHistory: async (historyOptions) => {
      assertOpen();
      const request = validateSearchGitHistoryOptions(historyOptions);
      return searchGitHistory(await gitIndex(), {
        query: request.query,
        ...request.allowedNoteIds === null ? {} : { allowedNoteIds: request.allowedNoteIds },
        limit: request.limit,
        commitsPerHit: request.commitsPerHit,
        cochangedPathsPerCommit: request.cochangedPathsPerCommit
      });
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
function utf8ContextWriter(maximumBytes) {
  const chunks = [];
  let bytes = 0;
  let truncated = false;
  return {
    append: (value, final = false) => {
      if (truncated)
        return false;
      const remaining = maximumBytes - bytes;
      const prefix = utf8Prefix(value, remaining);
      if (prefix.value !== "")
        chunks.push(prefix.value);
      bytes += prefix.bytes;
      if (prefix.truncated || !final && bytes === maximumBytes) {
        truncated = true;
        return false;
      }
      return true;
    },
    result: () => ({ content: chunks.join(""), truncated })
  };
}
function packSearchContext(result, options = {}) {
  const maximumBytes = checkedLimit(options.maxBytes, DEFAULT_CONTEXT_BYTES, MAX_CONTEXT_BYTES, "Context byte limit");
  const writer = utf8ContextWriter(maximumBytes);
  const append = (value) => writer.append(value);
  if (!append(`# Knowledge-base context

Query: `))
    return writer.result();
  if (!append(result.query))
    return writer.result();
  if (!append(`
Mode: `))
    return writer.result();
  if (!append(result.mode))
    return writer.result();
  if (!append(`
`))
    return writer.result();
  for (const hit of result.results) {
    if (!append(`

## `))
      return writer.result();
    if (!append(String(hit.rank)))
      return writer.result();
    if (!append(". "))
      return writer.result();
    if (!append(hit.title))
      return writer.result();
    if (!append(`

Path: `))
      return writer.result();
    if (!append(hit.path))
      return writer.result();
    if (hit.line !== undefined) {
      if (!append(":"))
        return writer.result();
      if (!append(String(hit.line)))
        return writer.result();
    }
    if (!append(`

Evidence: `))
      return writer.result();
    for (const [index, item] of hit.evidence.entries()) {
      if (index > 0 && !append(", "))
        return writer.result();
      if (!append(item.kind))
        return writer.result();
      if (!append("#"))
        return writer.result();
      if (!append(String(item.rank)))
        return writer.result();
    }
    if (!append(`

`))
      return writer.result();
    if (!append(hit.snippet))
      return writer.result();
  }
  const graph = result.graph;
  if (graph !== null && graph.related.length > 0) {
    if (!append(`

## Related graph context`))
      return writer.result();
    for (const [hitIndex, hit] of graph.related.entries()) {
      if (!append(hitIndex === 0 ? `

- ` : `
- `))
        return writer.result();
      if (!append(hit.path))
        return writer.result();
      if (!append(" ("))
        return writer.result();
      for (const [index, evidence] of hit.evidence.entries()) {
        if (index > 0 && !append(", "))
          return writer.result();
        if (!append(evidence.kind))
          return writer.result();
      }
      if (!append(")"))
        return writer.result();
    }
  }
  const history = result.history;
  if (history?.status === "ready") {
    if (!append(`

## Git provenance

`))
      return writer.result();
    const limitedCommits = history.limitedCommits ?? [];
    if (limitedCommits.length > 0) {
      if (!append("> Partial: "))
        return writer.result();
      if (!append(limitedHistoryMessage(limitedCommits)))
        return writer.result();
      if (!append(`

`))
        return writer.result();
    }
    let commitIndex = 0;
    for (const note of history.notes) {
      for (const commit of note.commits) {
        if (commitIndex > 0 && !append(`
`))
          return writer.result();
        if (!append("- "))
          return writer.result();
        if (!append(note.path))
          return writer.result();
        if (!append(": "))
          return writer.result();
        if (!append(commit.committedAt))
          return writer.result();
        if (!append(" "))
          return writer.result();
        if (!append(commit.hash.slice(0, 12)))
          return writer.result();
        if (!append(" "))
          return writer.result();
        if (!append(commit.subject))
          return writer.result();
        commitIndex += 1;
      }
    }
  }
  writer.append(`
`, true);
  return writer.result();
}

export { MAX_SEARCH_RESULTS, MAX_SEARCH_CANDIDATES, DEFAULT_SEARCH_RESULTS, MAX_SEARCH_RELATED_SEEDS, MAX_SEARCH_NOTE_REFERENCE_BYTES, openKnowledgeBase, packSearchContext };
