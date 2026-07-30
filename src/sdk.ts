import type { MetadataObject, Note } from "./graph.js";
import { lookupNote } from "./graph.js";
import {
  GitHistoryError,
  gitHistoryForNotes,
  indexGitHistory,
  searchGitHistory,
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

const MAX_SEARCH_RESULTS = 100;
const MAX_READ_BYTES = 64 * 1_024;
const DEFAULT_CONTEXT_BYTES = 24 * 1_024;
const MAX_CONTEXT_BYTES = 64 * 1_024;

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
} {
  if (Buffer.byteLength(value) <= maximumBytes) return { value, truncated: false };
  let bytes = 0;
  let prefix = "";
  for (const character of value) {
    const width = Buffer.byteLength(character);
    if (bytes + width > maximumBytes) break;
    prefix += character;
    bytes += width;
  }
  return { value: prefix, truncated: true };
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

type CheckedHistoryRequest =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly required: boolean;
      readonly options: KnowledgeBaseHistoryOptions;
    };

function checkedHistoryRequest(value: unknown): CheckedHistoryRequest {
  if (value === false) return { enabled: false };
  if (value === undefined || value === "auto") {
    return { enabled: true, required: false, options: {} };
  }
  if (value === "required") {
    return { enabled: true, required: true, options: {} };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      'Search history must be false, "auto", "required", or an options object.',
    );
  }
  const options = value as KnowledgeBaseHistoryOptions;
  if (
    options.policy !== undefined
    && options.policy !== "auto"
    && options.policy !== "required"
  ) {
    throw new Error('Search history policy must be "auto" or "required".');
  }
  return {
    enabled: true,
    required: options.policy === "required",
    options,
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
    const query = searchOptions.query.trim();
    if (query === "") throw new Error("Search query must not be empty.");
    const mode = checkedSearchMode(searchOptions.mode);
    if (
      searchOptions.minScore !== undefined
      && (
        !Number.isFinite(searchOptions.minScore)
        || searchOptions.minScore < 0
        || searchOptions.minScore > 1
      )
    ) {
      throw new RangeError("Search minimum score must be a number from 0 through 1.");
    }
    if (mode === "exact" && searchOptions.minScore !== undefined) {
      throw new Error("Search minimum score applies only to hybrid, keyword, or semantic mode.");
    }
    const limit = checkedLimit(searchOptions.limit, 10, MAX_SEARCH_RESULTS, "Search limit");
    const candidateLimit = checkedLimit(
      searchOptions.candidateLimit,
      Math.max(40, limit * 4),
      500,
      "Search candidate limit",
    );
    if (candidateLimit < limit) {
      throw new RangeError("Search candidate limit must be at least the result limit.");
    }
    const historyRequest = checkedHistoryRequest(searchOptions.history);
    const historyNoteLimit = historyRequest.enabled
      ? checkedLimit(
          historyRequest.options.noteLimit,
          5,
          20,
          "Git history note limit",
        )
      : null;
    const historyIndexPromise = !historyRequest.enabled
      ? null
      : gitIndex().then(
          (index) => ({ status: "indexed", index } as const),
          (error: unknown) => ({ status: "failed", error } as const),
        );
    const allowedIds = new Set(queryVault(snapshot.notes, snapshot.analysis, {
      filters: searchOptions.filters ?? [],
      tags: searchOptions.tags ?? [],
    }).map(({ id }) => id));
    const includeExact = mode === "hybrid" || mode === "exact";
    const exact = includeExact
      ? searchExactVault(snapshot.notes, snapshot.analysis, {
          query,
          filters: searchOptions.filters ?? [],
          tags: searchOptions.tags ?? [],
          limit: Math.min(500, candidateLimit),
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
      try {
        const session = await semantic();
        model = session.model;
        const semanticLimit = Math.min(MAX_SEARCH_RESULTS, candidateLimit);
        const result = await session.search({
          query,
          mode: selectedQmdMode,
          limit: semanticLimit,
          candidateLimit,
          ...(searchOptions.minScore === undefined
            ? {}
            : { minScore: searchOptions.minScore }),
        });
        let acceptedRank = 0;
        for (const hit of result.results) {
          const note = notesByPath.get(hit.path);
          if (note === undefined || !allowedIds.has(note.id) || semanticById.has(note.id)) continue;
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
          ...(embeddingDegraded
            ? {
                message: `QMD embedding reported ${embeddingErrors} error(s)`
                  + ` and ${embeddingFailures} retained failure record(s).`,
              }
            : {}),
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
    const lanes = [
      ...(includeExact
        ? [{ name: "exact", weight: 2, ids: exact.map(({ id }) => id) }]
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
    const graphOptions = searchOptions.graph === false ? null : searchOptions.graph ?? {};
    const explicitSeeds = graphOptions?.related ?? [];
    if (explicitSeeds.length > 5) {
      throw new RangeError("Hybrid search accepts at most 5 explicit related-note seeds.");
    }
    let graph: GraphContext | null = null;
    if (graphOptions !== null) {
      try {
        graph = buildGraphContext(snapshot.notes, snapshot.analysis, {
          seeds: [...explicitSeeds, ...results.slice(0, 5).map(({ id }) => id)],
          primaryIds: results.map(({ id }) => id),
          ...(graphOptions.depth === undefined ? {} : { depth: graphOptions.depth }),
          ...(graphOptions.neighborsPerSeed === undefined
            ? {}
            : { neighborsPerSeed: graphOptions.neighborsPerSeed }),
          ...(graphOptions.limit === undefined ? {} : { limit: graphOptions.limit }),
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
      && historyIndexPromise !== null
      && historyNoteLimit !== null
    ) {
      const outcome = await historyIndexPromise;
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
        {
          ...(historyRequest.options.commitsPerNote === undefined
            ? {}
            : { commitsPerNote: historyRequest.options.commitsPerNote }),
          ...(historyRequest.options.cochangedPathsPerCommit === undefined
            ? {}
            : {
                cochangedPathsPerCommit:
                  historyRequest.options.cochangedPathsPerCommit,
              }),
        },
      );
      diagnostics.push(history.status === "ready"
        ? {
            lane: "git",
            status: "ready",
            results: history.notes.length,
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
      return gitHistoryForNotes(await gitIndex(), noteIds, historyOptions);
    },
    searchHistory: async (historyOptions) => {
      assertOpen();
      return searchGitHistory(await gitIndex(), historyOptions);
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

/** Render a bounded Markdown handoff that preserves paths, ranks, and evidence. */
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
  const sections = [
    `# Knowledge-base context\n\nQuery: ${result.query}\nMode: ${result.mode}\n`,
    ...result.results.map((hit) => [
      `## ${hit.rank}. ${hit.title}`,
      `Path: ${hit.path}${hit.line === undefined ? "" : `:${hit.line}`}`,
      `Evidence: ${hit.evidence.map((item) => `${item.kind}#${item.rank}`).join(", ")}`,
      hit.snippet,
    ].join("\n\n")),
    ...(result.graph?.related.length === 0 || result.graph === null
      ? []
      : [
          "## Related graph context\n\n"
            + result.graph.related.map((hit) =>
              `- ${hit.path} (${hit.evidence.map(({ kind }) => kind).join(", ")})`).join("\n"),
        ]),
    ...(result.history?.status !== "ready"
      ? []
      : [
          "## Git provenance\n\n"
            + result.history.notes.flatMap((note) => note.commits.map((commit) =>
              `- ${note.path}: ${commit.committedAt} ${commit.hash.slice(0, 12)} ${commit.subject}`))
              .join("\n"),
        ]),
  ];
  const packed = utf8Prefix(`${sections.join("\n\n")}\n`, maximumBytes);
  return { content: packed.value, truncated: packed.truncated };
}
