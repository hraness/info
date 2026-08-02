import type { MetadataObject, Note } from "./graph.js";
import { lookupNote } from "./graph.js";
import {
  GitHistoryError,
  gitHistoryForNotes,
  indexGitHistory,
  searchGitHistory,
  validateGitHistoryForNotesOptions,
  validateGitHistoryForNotesRequest,
  validateSearchGitHistoryOptions,
  type GitHistoryDependencies,
  type GitHistoryForNotesOptions,
  type GitHistoryForNotesResult,
  type GitHistoryIndexResult,
  type GitHistorySearchResult,
  type SearchGitHistoryOptions,
} from "./git.js";
import {
  navigateLinks,
  NavigationBudgetError,
  type LinkNeighborhood,
  type NavigateLinksOptions,
} from "./navigation.js";
import {
  queryVault,
  type QueryOptions,
  type QueryRow,
} from "./query.js";
import {
  buildGraphContext,
  fuseRankedCandidates,
  searchExactVault,
  validateSearchQuery,
  type ExactMatchEvidence,
  type ExactSearchHit,
  type GraphContext,
  type GraphContextOptions,
  type FusionContribution,
} from "./search.js";
import {
  openSemanticSearchSession,
  recommendedEmbeddingModel,
  type SemanticDependencies,
  type SemanticSearchHit,
  type SemanticSearchMode,
  type SemanticSearchSession,
} from "./semantic.js";
import {
  scanVault,
  type ScanVaultOptions,
  type VaultSnapshot,
} from "./vault.js";

export const MAX_SEARCH_RESULTS = 100;
export const MAX_SEARCH_CANDIDATES = 500;
export const DEFAULT_SEARCH_RESULTS = 10;
const MAX_READ_BYTES = 64 * 1_024;
const DEFAULT_CONTEXT_BYTES = 24 * 1_024;
const MAX_CONTEXT_BYTES = 64 * 1_024;
const DEFAULT_SEARCH_HISTORY_NOTES = 5;
const MAX_SEARCH_HISTORY_NOTES = 20;
export const MAX_SEARCH_RELATED_SEEDS = 5;
export const MAX_SEARCH_NOTE_REFERENCE_BYTES = 16 * 1_024;

export type KnowledgeBaseSearchMode = "exact" | SemanticSearchMode;

export type KnowledgeBaseGraphOptions = Omit<
  GraphContextOptions,
  "seeds" | "primaryIds"
> & {
  /** Explicit note identities to seed before the strongest text results. */
  readonly related?: readonly string[];
};

export type KnowledgeBaseHistoryOptions = GitHistoryForNotesOptions & {
  /** Number of top primary results enriched with Git provenance. */
  readonly noteLimit?: number;
  /** Reject the search when Git provenance cannot be produced. */
  readonly policy?: "auto" | "required";
};

export type KnowledgeBaseSearchOptions = {
  readonly query: string;
  readonly mode?: KnowledgeBaseSearchMode;
  readonly filters?: QueryOptions["filters"];
  readonly tags?: readonly string[];
  /** Match any exact, case-sensitive canonical authored repository scope. */
  readonly repositoryScopes?: readonly string[];
  readonly limit?: number;
  readonly candidateLimit?: number;
  /** QMD-local score cutoff for hybrid, keyword, and semantic modes. */
  readonly minScore?: number;
  /** Explicit graph context is separate from the primary relevance rank. */
  readonly graph?: false | KnowledgeBaseGraphOptions;
  /** Git provenance is separate from the primary relevance rank. */
  readonly history?: false | "auto" | "required" | KnowledgeBaseHistoryOptions;
};

export type KnowledgeBaseExactEvidence = {
  readonly kind: "exact";
  readonly rank: number;
  readonly identity: boolean;
  readonly matches: readonly ExactMatchEvidence[];
};

export type KnowledgeBaseQmdEvidence = {
  readonly kind: "qmd";
  readonly rank: number;
  readonly source: SemanticSearchHit["source"];
  /** Backend-local score. It is not comparable across search modes. */
  readonly score: number;
  readonly signals?: SemanticSearchHit["signals"];
};

export type KnowledgeBaseSearchEvidence =
  | KnowledgeBaseExactEvidence
  | KnowledgeBaseQmdEvidence;

export type KnowledgeBaseSearchHit = {
  readonly id: string;
  readonly path: string;
  readonly title: string;
  readonly rank: number;
  /** Weighted reciprocal-rank score. It is not a probability. */
  readonly score: number;
  readonly identity: boolean;
  readonly line?: number;
  readonly snippet: string;
  readonly tags: readonly string[];
  readonly metadata: MetadataObject;
  readonly evidence: readonly KnowledgeBaseSearchEvidence[];
  readonly contributions: readonly FusionContribution[];
};

export type KnowledgeBaseSearchDiagnostic = {
  readonly lane: "exact" | "git" | "graph" | "qmd";
  readonly status: "degraded" | "ready" | "unavailable";
  readonly results: number;
  readonly message?: string;
};

export type KnowledgeBaseSearchResult = {
  readonly query: string;
  readonly mode: KnowledgeBaseSearchMode;
  readonly results: readonly KnowledgeBaseSearchHit[];
  readonly graph: GraphContext | null;
  readonly history: GitHistoryForNotesResult | null;
  readonly partial: boolean;
  readonly diagnostics: {
    readonly notes: number;
    readonly model: string | null;
    readonly elapsedMs: number;
    readonly lanes: readonly KnowledgeBaseSearchDiagnostic[];
  };
};

export type KnowledgeBaseReadResult = {
  readonly id: string;
  readonly path: string;
  readonly title: string;
  readonly content: string;
  readonly truncated: boolean;
};

export type OpenKnowledgeBaseOptions = {
  readonly root: string;
  /** Repository root enables bounded Git history and provenance. */
  readonly repository?: string;
  readonly database?: string;
  /** Verified local bytes for the pinned semantic model. */
  readonly embeddingModelFile?: string;
  readonly scan?: Omit<ScanVaultOptions, "mentionScope">;
};

export type KnowledgeBaseDependencies = {
  readonly scanVault?: typeof scanVault;
  readonly semantic?: SemanticDependencies;
  readonly openSemanticSearchSession?: typeof openSemanticSearchSession;
  readonly git?: GitHistoryDependencies;
  readonly indexGitHistory?: typeof indexGitHistory;
};

export type KnowledgeBaseSession = {
  readonly root: string;
  readonly repository?: string;
  readonly noteCount: number;
  readonly grep: (options: Parameters<typeof searchExactVault>[2]) => readonly ExactSearchHit[];
  readonly list: (options?: QueryOptions) => readonly QueryRow[];
  readonly read: (note: string, options?: { readonly maxBytes?: number }) => KnowledgeBaseReadResult;
  readonly links: (note: string, options?: NavigateLinksOptions) => LinkNeighborhood;
  readonly backlinks: (
    note: string,
    options?: Omit<NavigateLinksOptions, "direction">,
  ) => LinkNeighborhood;
  readonly search: (options: KnowledgeBaseSearchOptions) => Promise<KnowledgeBaseSearchResult>;
  readonly history: (
    noteIds: readonly string[],
    options?: GitHistoryForNotesOptions,
  ) => Promise<GitHistoryForNotesResult>;
  readonly searchHistory: (options: SearchGitHistoryOptions) => Promise<GitHistorySearchResult>;
  readonly close: () => Promise<void>;
};

function checkedLimit(
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string,
): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) {
    throw new RangeError(`${label} must be an integer from 1 through ${maximum}.`);
  }
  return limit;
}

function noteOrThrow(notes: readonly Note[], query: string): Note {
  const result = lookupNote(notes, query);
  if (result.kind === "found") return result.note;
  if (result.kind === "ambiguous") {
    throw new Error(
      `Knowledge-base note ${JSON.stringify(query)} is ambiguous: `
        + result.candidates.map(({ path }) => path).join(", "),
    );
  }
  throw new Error(`Knowledge-base note ${JSON.stringify(query)} was not found.`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function utf8Prefix(value: string, maximumBytes: number): {
  readonly value: string;
  readonly truncated: boolean;
  readonly bytes: number;
} {
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

function unavailableHistory(
  root: string,
  reason: string,
): GitHistoryIndexResult {
  return {
    status: "unavailable",
    repository: "",
    root,
    vaultPrefix: "",
    reason,
  };
}

function limitedHistoryMessage(
  commits: readonly { readonly pathLimit: number }[],
): string {
  const count = commits.length;
  const limit = commits[0]?.pathLimit ?? 0;
  return `${count} Git commit${count === 1 ? "" : "s"} exceeded the ${limit.toLocaleString("en-US")} changed-path detail limit; co-change evidence is incomplete.`;
}

function qmdMode(mode: KnowledgeBaseSearchMode): SemanticSearchMode | null {
  return mode === "exact" ? null : mode;
}

function checkedSearchMode(value: unknown): KnowledgeBaseSearchMode {
  const mode = value ?? "hybrid";
  if (
    mode !== "exact"
    && mode !== "hybrid"
    && mode !== "keyword"
    && mode !== "semantic"
  ) {
    throw new Error(
      'Knowledge-base search mode must be "exact", "hybrid", "keyword", or "semantic".',
    );
  }
  return mode;
}

type CheckedGraphOptions = {
  readonly related: readonly string[];
  readonly depth: number;
  readonly neighborsPerSeed: number;
  readonly limit: number;
};

function checkedGraphOptions(value: unknown): CheckedGraphOptions | null {
  if (value === false) return null;
  if (value !== undefined && (typeof value !== "object" || value === null || Array.isArray(value))) {
    throw new TypeError("Search graph options must be false or an options object.");
  }
  const options = (value ?? {}) as KnowledgeBaseGraphOptions;
  const related: unknown = options.related ?? [];
  if (!Array.isArray(related)) {
    throw new TypeError("Search related-note seeds must be an array.");
  }
  if (related.length > MAX_SEARCH_RELATED_SEEDS) {
    throw new RangeError(
      `Hybrid search accepts at most ${MAX_SEARCH_RELATED_SEEDS} explicit related-note seeds.`,
    );
  }
  const checkedRelated: string[] = [];
  for (const [index, seed] of (related as readonly unknown[]).entries()) {
    if (typeof seed !== "string") {
      throw new TypeError(`Search related-note seed ${index + 1} must be a string.`);
    }
    if (seed.trim() === "") {
      throw new TypeError(`Search related-note seed ${index + 1} must not be empty.`);
    }
    if (Buffer.byteLength(seed, "utf8") > MAX_SEARCH_NOTE_REFERENCE_BYTES) {
      throw new RangeError(
        `Search related-note seed ${index + 1} must be at most `
          + `${MAX_SEARCH_NOTE_REFERENCE_BYTES.toLocaleString("en-US")} UTF-8 bytes.`,
      );
    }
    checkedRelated.push(seed);
  }
  return Object.freeze({
    related: Object.freeze(checkedRelated),
    depth: checkedLimit(options.depth, 1, 2, "Graph context depth"),
    neighborsPerSeed: checkedLimit(
      options.neighborsPerSeed,
      3,
      20,
      "Graph neighbors per seed",
    ),
    limit: checkedLimit(options.limit, 20, 100, "Graph context limit"),
  });
}

function resolvedGraphSeeds(notes: readonly Note[], seeds: readonly string[]): readonly string[] {
  return seeds.map((seed) => {
    const lookup = lookupNote(notes, seed);
    if (lookup.kind === "missing") {
      throw new Error(`Graph context seed ${JSON.stringify(seed)} was not found.`);
    }
    if (lookup.kind === "ambiguous") {
      throw new Error(
        `Graph context seed ${JSON.stringify(seed)} is ambiguous: `
          + lookup.candidates.map(({ path }) => path).join(", "),
      );
    }
    return lookup.note.id;
  });
}

type CheckedHistoryRequest =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly required: boolean;
      readonly noteLimit: number;
      readonly options: Required<GitHistoryForNotesOptions>;
    };

function checkedHistoryRequest(value: unknown): CheckedHistoryRequest {
  if (value === undefined || value === false) return { enabled: false };
  let options: KnowledgeBaseHistoryOptions;
  let required: boolean;
  if (value === "auto") {
    options = {};
    required = false;
  } else if (value === "required") {
    options = {};
    required = true;
  } else if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      'Search history must be false, "auto", "required", or an options object.',
    );
  } else {
    options = value;
    if (
      options.policy !== undefined
      && options.policy !== "auto"
      && options.policy !== "required"
    ) {
      throw new Error('Search history policy must be "auto" or "required".');
    }
    required = options.policy === "required";
  }
  return {
    enabled: true,
    required,
    noteLimit: checkedLimit(
      options.noteLimit,
      DEFAULT_SEARCH_HISTORY_NOTES,
      MAX_SEARCH_HISTORY_NOTES,
      "Git history note limit",
    ),
    options: validateGitHistoryForNotesOptions(options),
  };
}

/** Open a read-only session that shares one live Markdown scan across retrieval tools. */
export async function openKnowledgeBase(
  options: OpenKnowledgeBaseOptions,
  dependencies: KnowledgeBaseDependencies = {},
): Promise<KnowledgeBaseSession> {
  const snapshot: VaultSnapshot = await (dependencies.scanVault ?? scanVault)(
    options.root,
    { ...(options.scan ?? {}), mentionScope: false },
  );
  const notesById = new Map(snapshot.notes.map((note) => [note.id, note]));
  const notesByPath = new Map(snapshot.notes.map((note) => [note.path, note]));
  let closeRequested = false;
  let closePromise: Promise<void> | undefined;
  let semanticPromise: Promise<SemanticSearchSession> | undefined;
  let gitPromise: Promise<GitHistoryIndexResult> | undefined;

  const assertOpen = (): void => {
    if (closeRequested) throw new Error("Knowledge-base session is closed.");
  };
  const semantic = (): Promise<SemanticSearchSession> => {
    assertOpen();
    semanticPromise ??= (dependencies.openSemanticSearchSession
      ?? openSemanticSearchSession)(
      {
        root: snapshot.root,
        ...(options.database === undefined ? {} : { database: options.database }),
        ...(options.embeddingModelFile === undefined
          ? {}
          : { embeddingModelFile: options.embeddingModelFile }),
      },
      {
        ...(dependencies.semantic ?? {}),
        scanVault: () => Promise.resolve(snapshot),
      },
    );
    return semanticPromise;
  };
  const gitIndex = (): Promise<GitHistoryIndexResult> => {
    assertOpen();
    if (options.repository === undefined) {
      return Promise.resolve(unavailableHistory(
        snapshot.root,
        "No repository root was configured for this knowledge-base session.",
      ));
    }
    gitPromise ??= (dependencies.indexGitHistory ?? indexGitHistory)(
      {
        repository: options.repository,
        root: snapshot.root,
        notes: snapshot.notes,
      },
      dependencies.git,
    );
    return gitPromise;
  };

  const grep = (
    grepOptions: Parameters<typeof searchExactVault>[2],
  ): readonly ExactSearchHit[] => {
    assertOpen();
    return searchExactVault(snapshot.notes, snapshot.analysis, grepOptions);
  };
  const list = (queryOptions: QueryOptions = {}): readonly QueryRow[] => {
    assertOpen();
    return queryVault(snapshot.notes, snapshot.analysis, queryOptions);
  };
  const read = (
    query: string,
    readOptions: { readonly maxBytes?: number } = {},
  ): KnowledgeBaseReadResult => {
    assertOpen();
    const maximumBytes = checkedLimit(
      readOptions.maxBytes,
      MAX_READ_BYTES,
      MAX_READ_BYTES,
      "Read byte limit",
    );
    const note = noteOrThrow(snapshot.notes, query);
    const content = utf8Prefix(note.content, maximumBytes);
    return {
      id: note.id,
      path: note.path,
      title: note.title,
      content: content.value,
      truncated: content.truncated,
    };
  };
  const links = (
    query: string,
    linkOptions: NavigateLinksOptions = {},
  ): LinkNeighborhood => {
    assertOpen();
    return navigateLinks(
      snapshot.notes,
      snapshot.analysis,
      noteOrThrow(snapshot.notes, query),
      linkOptions,
    );
  };

  const search = async (
    searchOptions: KnowledgeBaseSearchOptions,
  ): Promise<KnowledgeBaseSearchResult> => {
    assertOpen();
    const startedAt = performance.now();
    const { query } = validateSearchQuery(searchOptions.query);
    const mode = checkedSearchMode(searchOptions.mode);
    const minScore = searchOptions.minScore;
    if (
      minScore !== undefined
      && (
        !Number.isFinite(minScore)
        || minScore < 0
        || minScore > 1
      )
    ) {
      throw new RangeError("Search minimum score must be a number from 0 through 1.");
    }
    if (mode === "exact" && minScore !== undefined) {
      throw new Error("Search minimum score applies only to hybrid, keyword, or semantic mode.");
    }
    const limit = checkedLimit(
      searchOptions.limit,
      DEFAULT_SEARCH_RESULTS,
      MAX_SEARCH_RESULTS,
      "Search limit",
    );
    const filters = searchOptions.filters ?? [];
    const tags = searchOptions.tags ?? [];
    const repositoryScopes = searchOptions.repositoryScopes ?? [];
    const filtered = filters.length > 0 || tags.length > 0 || repositoryScopes.length > 0;
    const candidateLimit = checkedLimit(
      searchOptions.candidateLimit,
      filtered ? MAX_SEARCH_CANDIDATES : Math.max(40, limit * 4),
      MAX_SEARCH_CANDIDATES,
      "Search candidate limit",
    );
    if (candidateLimit < limit) {
      throw new RangeError("Search candidate limit must be at least the result limit.");
    }
    const historyRequest = checkedHistoryRequest(searchOptions.history);
    const graphOptions = checkedGraphOptions(searchOptions.graph);
    const explicitSeeds = graphOptions === null
      ? []
      : resolvedGraphSeeds(snapshot.notes, graphOptions.related);
    const historyNoteLimit = historyRequest.enabled ? historyRequest.noteLimit : null;
    const allowedIds = new Set(queryVault(snapshot.notes, snapshot.analysis, {
      filters,
      tags,
      repositoryScopes,
    }).map(({ id }) => id));
    const includeExact = mode === "hybrid" || mode === "exact";
    const exact = includeExact
      ? searchExactVault(snapshot.notes, snapshot.analysis, {
          query,
          filters,
          tags,
          repositoryScopes,
          limit: Math.min(MAX_SEARCH_CANDIDATES, candidateLimit),
        })
      : [];
    const exactById = new Map(exact.map((hit, index) => [hit.id, { hit, rank: index + 1 }]));
    const semanticById = new Map<string, { readonly hit: SemanticSearchHit; readonly rank: number }>();
    const diagnostics: KnowledgeBaseSearchDiagnostic[] = includeExact
      ? [{ lane: "exact", status: "ready", results: exact.length }]
      : [];
    let model: string | null = null;
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
            ...(minScore === undefined
              ? {}
              : { minScore }),
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
          const incompleteCandidateWindow = discardedCandidates > 0
            && semanticById.size < requestedEligible;
          const messages: string[] = [];
          if (embeddingDegraded) {
            messages.push(
              `QMD embedding reported ${embeddingErrors} error(s)`
                + ` and ${embeddingFailures} retained failure record(s).`,
            );
          }
          if (incompleteCandidateWindow) {
            messages.push(
              `QMD's bounded ${semanticLimit}-candidate retrieval discarded `
                + `${discardedCandidates} row(s) during live reconciliation or metadata filtering `
                + `and accepted ${semanticById.size} of ${requestedEligible} eligible requested `
                + "result(s); this bounded reconciliation cannot certify a complete eligible result set.",
            );
          }
          diagnostics.push({
            lane: "qmd",
            status: embeddingDegraded || incompleteCandidateWindow ? "degraded" : "ready",
            results: semanticById.size,
            ...(messages.length === 0 ? {} : { message: messages.join(" ") }),
          });
        } catch (error: unknown) {
          diagnostics.push({
            lane: "qmd",
            status: "unavailable",
            results: 0,
            message: errorMessage(error),
          });
        }
      }
    }
    const lanes = [
      ...(includeExact
        ? [{ name: "exact", weight: 1, ids: exact.map(({ id }) => id) }]
        : []),
      ...(selectedQmdMode === null
        ? []
        : [{ name: "qmd", weight: 1, ids: [...semanticById.keys()] }]),
    ];
    const fused = fuseRankedCandidates(lanes);
    const ordered = fused.toSorted((left, right) =>
      Number(exactById.get(right.id)?.hit.identity ?? false)
        - Number(exactById.get(left.id)?.hit.identity ?? false)
      || left.rank - right.rank
      || left.id.localeCompare(right.id));
    const results = ordered.slice(0, limit).map((candidate, index): KnowledgeBaseSearchHit => {
      const note = notesById.get(candidate.id);
      if (note === undefined) {
        throw new Error(`Fused retrieval returned unknown note ${JSON.stringify(candidate.id)}.`);
      }
      const exactMatch = exactById.get(candidate.id);
      const semanticMatch = semanticById.get(candidate.id);
      const evidence: KnowledgeBaseSearchEvidence[] = [];
      if (exactMatch !== undefined) {
        evidence.push({
          kind: "exact",
          rank: exactMatch.rank,
          identity: exactMatch.hit.identity,
          matches: exactMatch.hit.matches,
        });
      }
      if (semanticMatch !== undefined) {
        evidence.push({
          kind: "qmd",
          rank: semanticMatch.rank,
          source: semanticMatch.hit.source,
          score: semanticMatch.hit.score,
          ...(semanticMatch.hit.signals === undefined
            ? {}
            : { signals: semanticMatch.hit.signals }),
        });
      }
      const snippetSource = exactMatch?.hit.identity === true || semanticMatch === undefined
        ? exactMatch?.hit
        : semanticMatch.hit;
      return {
        id: note.id,
        path: note.path,
        title: note.title,
        rank: index + 1,
        score: candidate.score,
        identity: exactMatch?.hit.identity ?? false,
        ...(snippetSource?.line === undefined ? {} : { line: snippetSource.line }),
        snippet: snippetSource?.snippet ?? note.summary,
        tags: note.tags,
        metadata: note.metadata,
        evidence,
        contributions: candidate.contributions,
      };
    });
    let graph: GraphContext | null = null;
    if (graphOptions !== null) {
      try {
        graph = buildGraphContext(snapshot.notes, snapshot.analysis, {
          seeds: [...explicitSeeds, ...results.slice(0, 5).map(({ id }) => id)],
          primaryIds: results.map(({ id }) => id),
          depth: graphOptions.depth,
          neighborsPerSeed: graphOptions.neighborsPerSeed,
          limit: graphOptions.limit,
        });
        diagnostics.push({
          lane: "graph",
          status: "ready",
          results: graph.related.length,
        });
      } catch (error: unknown) {
        if (!(error instanceof NavigationBudgetError)) throw error;
        diagnostics.push({
          lane: "graph",
          status: "unavailable",
          results: 0,
          message: error.message,
        });
      }
    }
    let history: GitHistoryForNotesResult | null = null;
    if (
      historyRequest.enabled
      && historyNoteLimit !== null
      && results.length > 0
    ) {
      const outcome = await gitIndex().then(
        (index) => ({ status: "indexed", index } as const),
        (error: unknown) => ({ status: "failed", error } as const),
      );
      let index: GitHistoryIndexResult;
      if (outcome.status === "failed") {
        if (historyRequest.required) throw outcome.error;
        index = unavailableHistory(snapshot.root, errorMessage(outcome.error));
      } else {
        index = outcome.index;
      }
      if (historyRequest.required && index.status === "unavailable") {
        throw new GitHistoryError(
          "unavailable",
          `Required Git history is unavailable: ${index.reason}`,
        );
      }
      history = gitHistoryForNotes(
        index,
        results.slice(0, historyNoteLimit).map(({ id }) => id),
        historyRequest.options,
      );
      const limitedCommits = history.status === "ready"
        ? history.limitedCommits ?? []
        : [];
      if (historyRequest.required && limitedCommits.length > 0) {
        throw new GitHistoryError(
          "budget",
          `Required Git history is incomplete: ${limitedHistoryMessage(limitedCommits)}`,
        );
      }
      diagnostics.push(history.status === "ready" && limitedCommits.length === 0
        ? {
            lane: "git",
            status: "ready",
            results: history.notes.length,
          }
        : history.status === "ready"
          ? {
              lane: "git",
              status: "degraded",
              results: history.notes.length,
              message: limitedHistoryMessage(limitedCommits),
            }
        : {
            lane: "git",
            status: "unavailable",
            results: 0,
            message: history.reason,
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
        lanes: diagnostics,
      },
    };
  };

  return {
    root: snapshot.root,
    ...(options.repository === undefined ? {} : { repository: options.repository }),
    noteCount: snapshot.notes.length,
    grep,
    list,
    read,
    links,
    backlinks: (query, linkOptions = {}) => links(query, {
      ...linkOptions,
      direction: "in",
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
        ...(request.allowedNoteIds === null ? {} : { allowedNoteIds: request.allowedNoteIds }),
        limit: request.limit,
        commitsPerHit: request.commitsPerHit,
        cochangedPathsPerCommit: request.cochangedPathsPerCommit,
      });
    },
    close: () => {
      if (closePromise !== undefined) return closePromise;
      closeRequested = true;
      closePromise = semanticPromise === undefined
        ? Promise.resolve()
        : semanticPromise.then(
            (session) => session.close(),
            () => undefined,
          );
      return closePromise;
    },
  };
}

type Utf8ContextWriter = {
  readonly append: (value: string, final?: boolean) => boolean;
  readonly result: () => { readonly content: string; readonly truncated: boolean };
};

function utf8ContextWriter(maximumBytes: number): Utf8ContextWriter {
  const chunks: string[] = [];
  let bytes = 0;
  let truncated = false;
  return {
    append: (value, final = false) => {
      if (truncated) return false;
      const remaining = maximumBytes - bytes;
      const prefix = utf8Prefix(value, remaining);
      if (prefix.value !== "") chunks.push(prefix.value);
      bytes += prefix.bytes;
      if (prefix.truncated || (!final && bytes === maximumBytes)) {
        // At least the final newline remains at an exact non-final boundary,
        // so no later field is needed to prove that the result is partial.
        truncated = true;
        return false;
      }
      return true;
    },
    result: () => ({ content: chunks.join(""), truncated }),
  };
}

/** Render a bounded Markdown handoff without evaluating fields past its byte budget. */
export function packSearchContext(
  result: KnowledgeBaseSearchResult,
  options: { readonly maxBytes?: number } = {},
): { readonly content: string; readonly truncated: boolean } {
  const maximumBytes = checkedLimit(
    options.maxBytes,
    DEFAULT_CONTEXT_BYTES,
    MAX_CONTEXT_BYTES,
    "Context byte limit",
  );
  const writer = utf8ContextWriter(maximumBytes);
  const append = (value: string): boolean => writer.append(value);
  if (!append("# Knowledge-base context\n\nQuery: ")) return writer.result();
  if (!append(result.query)) return writer.result();
  if (!append("\nMode: ")) return writer.result();
  if (!append(result.mode)) return writer.result();
  if (!append("\n")) return writer.result();

  for (const hit of result.results) {
    if (!append("\n\n## ")) return writer.result();
    if (!append(String(hit.rank))) return writer.result();
    if (!append(". ")) return writer.result();
    if (!append(hit.title)) return writer.result();
    if (!append("\n\nPath: ")) return writer.result();
    if (!append(hit.path)) return writer.result();
    if (hit.line !== undefined) {
      if (!append(":")) return writer.result();
      if (!append(String(hit.line))) return writer.result();
    }
    if (!append("\n\nEvidence: ")) return writer.result();
    for (const [index, item] of hit.evidence.entries()) {
      if (index > 0 && !append(", ")) return writer.result();
      if (!append(item.kind)) return writer.result();
      if (!append("#")) return writer.result();
      if (!append(String(item.rank))) return writer.result();
    }
    if (!append("\n\n")) return writer.result();
    if (!append(hit.snippet)) return writer.result();
  }

  const graph = result.graph;
  if (graph !== null && graph.related.length > 0) {
    if (!append("\n\n## Related graph context")) return writer.result();
    for (const [hitIndex, hit] of graph.related.entries()) {
      if (!append(hitIndex === 0 ? "\n\n- " : "\n- ")) return writer.result();
      if (!append(hit.path)) return writer.result();
      if (!append(" (")) return writer.result();
      for (const [index, evidence] of hit.evidence.entries()) {
        if (index > 0 && !append(", ")) return writer.result();
        if (!append(evidence.kind)) return writer.result();
      }
      if (!append(")")) return writer.result();
    }
  }

  const history = result.history;
  if (history?.status === "ready") {
    if (!append("\n\n## Git provenance\n\n")) return writer.result();
    const limitedCommits = history.limitedCommits ?? [];
    if (limitedCommits.length > 0) {
      if (!append("> Partial: ")) return writer.result();
      if (!append(limitedHistoryMessage(limitedCommits))) return writer.result();
      if (!append("\n\n")) return writer.result();
    }
    let commitIndex = 0;
    for (const note of history.notes) {
      for (const commit of note.commits) {
        if (commitIndex > 0 && !append("\n")) return writer.result();
        if (!append("- ")) return writer.result();
        if (!append(note.path)) return writer.result();
        if (!append(": ")) return writer.result();
        if (!append(commit.committedAt)) return writer.result();
        if (!append(" ")) return writer.result();
        if (!append(commit.hash.slice(0, 12))) return writer.result();
        if (!append(" ")) return writer.result();
        if (!append(commit.subject)) return writer.result();
        commitIndex += 1;
      }
    }
  }
  writer.append("\n", true);
  return writer.result();
}
