import { fuseRankedCandidates } from "./search.js";

const MAX_BENCHMARK_CASES = 500;
const MAX_BENCHMARK_SYSTEMS = 16;
const MAX_JUDGMENTS_PER_CASE = 1_000;
const MAX_RESULTS_PER_RANKING = 1_000;
const MAX_CUTOFF = 100;
const MAX_RELEVANCE = 10;

export type RelevanceJudgment = {
  readonly id: string;
  /** A positive integer. Larger values mean that a result is more useful. */
  readonly relevance: number;
};

export type BenchmarkRanking = {
  readonly system: string;
  readonly ids: readonly string[];
};

export type RetrievalBenchmarkCase = {
  readonly id: string;
  readonly queryClass: string;
  readonly judgments: readonly RelevanceJudgment[];
  readonly rankings: readonly BenchmarkRanking[];
};

export type RetrievalMetrics = {
  readonly recallAtK: number;
  readonly mrrAtK: number;
  readonly ndcgAtK: number;
};

export type EvaluatedRanking = {
  readonly system: string;
  readonly metrics: RetrievalMetrics;
};

export type EvaluatedBenchmarkCase = {
  readonly id: string;
  readonly queryClass: string;
  readonly systems: readonly EvaluatedRanking[];
};

export type BenchmarkAggregate = {
  readonly system: string;
  readonly caseCount: number;
  readonly metrics: RetrievalMetrics;
};

export type BenchmarkClassAggregate = {
  readonly queryClass: string;
  readonly caseCount: number;
  readonly systems: readonly BenchmarkAggregate[];
};

export type RetrievalBenchmarkReport = {
  readonly cutoff: number;
  readonly cases: readonly EvaluatedBenchmarkCase[];
  readonly overall: readonly BenchmarkAggregate[];
  readonly byClass: readonly BenchmarkClassAggregate[];
};

export type RetrievalBenchmarkOptions = {
  readonly cutoff?: number;
};

function checkedCutoff(value: number | undefined): number {
  const cutoff = value ?? 10;
  if (!Number.isSafeInteger(cutoff) || cutoff < 1 || cutoff > MAX_CUTOFF) {
    throw new RangeError(
      `Benchmark cutoff must be an integer from 1 through ${MAX_CUTOFF}.`,
    );
  }
  return cutoff;
}

function checkedLabel(value: string, label: string): string {
  if (value.trim() === "" || value !== value.trim()) {
    throw new Error(`${label} must be non-empty and have no outer whitespace.`);
  }
  return value;
}

function validatedJudgments(
  judgments: readonly RelevanceJudgment[],
): ReadonlyMap<string, number> {
  if (judgments.length === 0 || judgments.length > MAX_JUDGMENTS_PER_CASE) {
    throw new RangeError(
      `A benchmark case requires from 1 through ${MAX_JUDGMENTS_PER_CASE} judgments.`,
    );
  }
  const result = new Map<string, number>();
  for (const judgment of judgments) {
    const id = checkedLabel(judgment.id, "Judgment id");
    if (result.has(id)) throw new Error(`Duplicate judgment id: ${id}`);
    if (!Number.isSafeInteger(judgment.relevance)
      || judgment.relevance < 1
      || judgment.relevance > MAX_RELEVANCE) {
      throw new RangeError(
        `Judgment relevance must be an integer from 1 through ${MAX_RELEVANCE}.`,
      );
    }
    result.set(id, judgment.relevance);
  }
  return result;
}

function validatedRanking(ids: readonly string[]): readonly string[] {
  if (ids.length > MAX_RESULTS_PER_RANKING) {
    throw new RangeError(
      `A benchmark ranking may contain at most ${MAX_RESULTS_PER_RANKING} results.`,
    );
  }
  const seen = new Set<string>();
  return ids.map((rawId) => {
    const id = checkedLabel(rawId, "Ranking result id");
    if (seen.has(id)) throw new Error(`Duplicate ranking result id: ${id}`);
    seen.add(id);
    return id;
  });
}

function discount(rank: number): number {
  return Math.log2(rank + 1);
}

function gain(relevance: number): number {
  return (2 ** relevance) - 1;
}

function metricsForValidatedRanking(
  ranking: readonly string[],
  judgments: ReadonlyMap<string, number>,
  cutoff: number,
): RetrievalMetrics {
  const top = ranking.slice(0, cutoff);
  let relevantRetrieved = 0;
  let firstRelevantRank: number | null = null;
  let dcg = 0;
  for (const [index, id] of top.entries()) {
    const relevance = judgments.get(id) ?? 0;
    if (relevance === 0) continue;
    relevantRetrieved += 1;
    firstRelevantRank ??= index + 1;
    dcg += gain(relevance) / discount(index + 1);
  }
  const idealDcg = [...judgments.values()]
    .toSorted((left, right) => right - left)
    .slice(0, cutoff)
    .reduce((sum, relevance, index) =>
      sum + (gain(relevance) / discount(index + 1)), 0);
  return {
    recallAtK: relevantRetrieved / judgments.size,
    mrrAtK: firstRelevantRank === null ? 0 : 1 / firstRelevantRank,
    ndcgAtK: Math.min(1, dcg / idealDcg),
  };
}

/** Evaluate one unique ranked list against positive graded judgments. */
export function evaluateRanking(
  ranking: readonly string[],
  judgments: readonly RelevanceJudgment[],
  cutoff = 10,
): RetrievalMetrics {
  return metricsForValidatedRanking(
    validatedRanking(ranking),
    validatedJudgments(judgments),
    checkedCutoff(cutoff),
  );
}

function averageMetrics(
  evaluations: readonly EvaluatedRanking[],
): RetrievalMetrics {
  if (evaluations.length === 0) {
    return { recallAtK: 0, mrrAtK: 0, ndcgAtK: 0 };
  }
  const totals = evaluations.reduce((sum, evaluation) => ({
    recallAtK: sum.recallAtK + evaluation.metrics.recallAtK,
    mrrAtK: sum.mrrAtK + evaluation.metrics.mrrAtK,
    ndcgAtK: sum.ndcgAtK + evaluation.metrics.ndcgAtK,
  }), { recallAtK: 0, mrrAtK: 0, ndcgAtK: 0 });
  return {
    recallAtK: totals.recallAtK / evaluations.length,
    mrrAtK: totals.mrrAtK / evaluations.length,
    ndcgAtK: totals.ndcgAtK / evaluations.length,
  };
}

function aggregateSystems(
  cases: readonly EvaluatedBenchmarkCase[],
  systems: readonly string[],
): readonly BenchmarkAggregate[] {
  return systems.map((system) => {
    const evaluations = cases.map((benchmarkCase) => {
      const evaluation = benchmarkCase.systems.find((item) => item.system === system);
      if (evaluation === undefined) {
        throw new Error(`Missing system ${system} in evaluated case ${benchmarkCase.id}.`);
      }
      return evaluation;
    });
    return {
      system,
      caseCount: evaluations.length,
      metrics: averageMetrics(evaluations),
    };
  });
}

/**
 * Evaluate comparable system rankings over a bounded labeled query set.
 * Output is sorted by stable identifiers, so reordering the input does not
 * change the report.
 */
export function evaluateRetrievalBenchmark(
  benchmarkCases: readonly RetrievalBenchmarkCase[],
  options: RetrievalBenchmarkOptions = {},
): RetrievalBenchmarkReport {
  const cutoff = checkedCutoff(options.cutoff);
  if (benchmarkCases.length === 0 || benchmarkCases.length > MAX_BENCHMARK_CASES) {
    throw new RangeError(
      `A retrieval benchmark requires from 1 through ${MAX_BENCHMARK_CASES} cases.`,
    );
  }
  const caseIds = new Set<string>();
  let expectedSystems: readonly string[] | null = null;
  const evaluated = benchmarkCases.map((benchmarkCase) => {
    const id = checkedLabel(benchmarkCase.id, "Benchmark case id");
    const queryClass = checkedLabel(benchmarkCase.queryClass, "Query class");
    if (caseIds.has(id)) throw new Error(`Duplicate benchmark case id: ${id}`);
    caseIds.add(id);
    const judgments = validatedJudgments(benchmarkCase.judgments);
    if (benchmarkCase.rankings.length === 0
      || benchmarkCase.rankings.length > MAX_BENCHMARK_SYSTEMS) {
      throw new RangeError(
        `A benchmark case requires from 1 through ${MAX_BENCHMARK_SYSTEMS} systems.`,
      );
    }
    const systemNames = new Set<string>();
    const systems = benchmarkCase.rankings.map((ranking) => {
      const system = checkedLabel(ranking.system, "Benchmark system");
      if (systemNames.has(system)) throw new Error(`Duplicate benchmark system: ${system}`);
      systemNames.add(system);
      return {
        system,
        metrics: metricsForValidatedRanking(
          validatedRanking(ranking.ids),
          judgments,
          cutoff,
        ),
      };
    }).toSorted((left, right) => left.system.localeCompare(right.system));
    const names = systems.map(({ system }) => system);
    if (expectedSystems === null) {
      expectedSystems = names;
    } else if (names.length !== expectedSystems.length
      || names.some((name, index) => name !== expectedSystems?.[index])) {
      throw new Error("Every benchmark case must contain the same systems.");
    }
    return { id, queryClass, systems };
  }).toSorted((left, right) => left.id.localeCompare(right.id));

  const systems: readonly string[] = expectedSystems ?? [];
  const queryClasses = [...new Set(evaluated.map(({ queryClass }) => queryClass))]
    .toSorted((left, right) => left.localeCompare(right));
  return {
    cutoff,
    cases: evaluated,
    overall: aggregateSystems(evaluated, systems),
    byClass: queryClasses.map((queryClass) => {
      const matching = evaluated.filter((item) => item.queryClass === queryClass);
      return {
        queryClass,
        caseCount: matching.length,
        systems: aggregateSystems(matching, systems),
      };
    }),
  };
}

function fixtureCase(
  id: string,
  queryClass: string,
  judgments: readonly RelevanceJudgment[],
  exact: readonly string[],
  semanticLike: readonly string[],
): RetrievalBenchmarkCase {
  const hybrid = fuseRankedCandidates([
    { name: "exact", weight: 2, ids: exact },
    { name: "semantic-like", weight: 1, ids: semanticLike },
  ]).map(({ id: resultId }) => resultId);
  return {
    id,
    queryClass,
    judgments,
    rankings: [
      { system: "exact", ids: exact },
      { system: "hybrid-rrf", ids: hybrid },
      { system: "semantic-like", ids: semanticLike },
    ],
  };
}

/**
 * A deterministic regression fixture spanning identity, conceptual, and mixed
 * query shapes. Its synthetic semantic-like rankings exercise complementarity;
 * the fixture does not establish universal superiority over either input lane.
 */
export function createRepresentativeRetrievalFixture(): readonly RetrievalBenchmarkCase[] {
  return [
    fixtureCase(
      "alias-identity",
      "identity",
      [{ id: "write-path", relevance: 3 }, { id: "agent-memory", relevance: 1 }],
      ["write-path", "agent-memory", "durable-notes"],
      ["durable-notes", "context-window", "write-path", "agent-memory"],
    ),
    fixtureCase(
      "literal-title",
      "identity",
      [{ id: "repository-context", relevance: 3 }],
      ["repository-context", "repository-map"],
      ["repository-map", "repository-context", "shared-context"],
    ),
    fixtureCase(
      "paraphrased-memory",
      "conceptual",
      [{ id: "durable-memory", relevance: 3 }, { id: "write-path", relevance: 1 }],
      ["chat-history", "context-window", "durable-memory", "write-path"],
      ["durable-memory", "write-path", "chat-history"],
    ),
    fixtureCase(
      "meaning-without-keywords",
      "conceptual",
      [{ id: "retrieval-fusion", relevance: 3 }, { id: "local-search", relevance: 2 }],
      ["retrieval-fusion", "ranking-noise", "local-search"],
      ["embedding-noise", "retrieval-fusion", "local-search"],
    ),
    fixtureCase(
      "implementation-decision",
      "mixed",
      [
        { id: "decision", relevance: 3 },
        { id: "evidence", relevance: 2 },
        { id: "history", relevance: 1 },
      ],
      ["decision", "filename-noise", "evidence", "tag-noise", "history"],
      ["semantic-noise", "evidence", "decision", "history"],
    ),
    fixtureCase(
      "plan-context",
      "mixed",
      [{ id: "active-plan", relevance: 3 }, { id: "prior-rationale", relevance: 2 }],
      ["active-plan", "status-noise", "prior-rationale"],
      ["concept-noise", "prior-rationale", "active-plan"],
    ),
  ];
}
