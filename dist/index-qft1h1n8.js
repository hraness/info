// @bun
import {
  fuseRankedCandidates
} from "./index-ahw5amhf.js";

// src/benchmark.ts
var MAX_BENCHMARK_CASES = 500;
var MAX_BENCHMARK_SYSTEMS = 16;
var MAX_JUDGMENTS_PER_CASE = 1000;
var MAX_RESULTS_PER_RANKING = 1000;
var MAX_CUTOFF = 100;
var MAX_RELEVANCE = 10;
function checkedCutoff(value) {
  const cutoff = value ?? 10;
  if (!Number.isSafeInteger(cutoff) || cutoff < 1 || cutoff > MAX_CUTOFF) {
    throw new RangeError(`Benchmark cutoff must be an integer from 1 through ${MAX_CUTOFF}.`);
  }
  return cutoff;
}
function checkedLabel(value, label) {
  if (value.trim() === "" || value !== value.trim()) {
    throw new Error(`${label} must be non-empty and have no outer whitespace.`);
  }
  return value;
}
function validatedJudgments(judgments) {
  if (judgments.length === 0 || judgments.length > MAX_JUDGMENTS_PER_CASE) {
    throw new RangeError(`A benchmark case requires from 1 through ${MAX_JUDGMENTS_PER_CASE} judgments.`);
  }
  const result = new Map;
  for (const judgment of judgments) {
    const id = checkedLabel(judgment.id, "Judgment id");
    if (result.has(id))
      throw new Error(`Duplicate judgment id: ${id}`);
    if (!Number.isSafeInteger(judgment.relevance) || judgment.relevance < 1 || judgment.relevance > MAX_RELEVANCE) {
      throw new RangeError(`Judgment relevance must be an integer from 1 through ${MAX_RELEVANCE}.`);
    }
    result.set(id, judgment.relevance);
  }
  return result;
}
function validatedRanking(ids) {
  if (ids.length > MAX_RESULTS_PER_RANKING) {
    throw new RangeError(`A benchmark ranking may contain at most ${MAX_RESULTS_PER_RANKING} results.`);
  }
  const seen = new Set;
  return ids.map((rawId) => {
    const id = checkedLabel(rawId, "Ranking result id");
    if (seen.has(id))
      throw new Error(`Duplicate ranking result id: ${id}`);
    seen.add(id);
    return id;
  });
}
function discount(rank) {
  return Math.log2(rank + 1);
}
function gain(relevance) {
  return 2 ** relevance - 1;
}
function metricsForValidatedRanking(ranking, judgments, cutoff) {
  const top = ranking.slice(0, cutoff);
  let relevantRetrieved = 0;
  let firstRelevantRank = null;
  let dcg = 0;
  for (const [index, id] of top.entries()) {
    const relevance = judgments.get(id) ?? 0;
    if (relevance === 0)
      continue;
    relevantRetrieved += 1;
    firstRelevantRank ??= index + 1;
    dcg += gain(relevance) / discount(index + 1);
  }
  const idealDcg = [...judgments.values()].toSorted((left, right) => right - left).slice(0, cutoff).reduce((sum, relevance, index) => sum + gain(relevance) / discount(index + 1), 0);
  return {
    recallAtK: relevantRetrieved / judgments.size,
    mrrAtK: firstRelevantRank === null ? 0 : 1 / firstRelevantRank,
    ndcgAtK: Math.min(1, dcg / idealDcg)
  };
}
function evaluateRanking(ranking, judgments, cutoff = 10) {
  return metricsForValidatedRanking(validatedRanking(ranking), validatedJudgments(judgments), checkedCutoff(cutoff));
}
function averageMetrics(evaluations) {
  if (evaluations.length === 0) {
    return { recallAtK: 0, mrrAtK: 0, ndcgAtK: 0 };
  }
  const totals = evaluations.reduce((sum, evaluation) => ({
    recallAtK: sum.recallAtK + evaluation.metrics.recallAtK,
    mrrAtK: sum.mrrAtK + evaluation.metrics.mrrAtK,
    ndcgAtK: sum.ndcgAtK + evaluation.metrics.ndcgAtK
  }), { recallAtK: 0, mrrAtK: 0, ndcgAtK: 0 });
  return {
    recallAtK: totals.recallAtK / evaluations.length,
    mrrAtK: totals.mrrAtK / evaluations.length,
    ndcgAtK: totals.ndcgAtK / evaluations.length
  };
}
function aggregateSystems(cases, systems) {
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
      metrics: averageMetrics(evaluations)
    };
  });
}
function evaluateRetrievalBenchmark(benchmarkCases, options = {}) {
  const cutoff = checkedCutoff(options.cutoff);
  if (benchmarkCases.length === 0 || benchmarkCases.length > MAX_BENCHMARK_CASES) {
    throw new RangeError(`A retrieval benchmark requires from 1 through ${MAX_BENCHMARK_CASES} cases.`);
  }
  const caseIds = new Set;
  let expectedSystems = null;
  const evaluated = benchmarkCases.map((benchmarkCase) => {
    const id = checkedLabel(benchmarkCase.id, "Benchmark case id");
    const queryClass = checkedLabel(benchmarkCase.queryClass, "Query class");
    if (caseIds.has(id))
      throw new Error(`Duplicate benchmark case id: ${id}`);
    caseIds.add(id);
    const judgments = validatedJudgments(benchmarkCase.judgments);
    if (benchmarkCase.rankings.length === 0 || benchmarkCase.rankings.length > MAX_BENCHMARK_SYSTEMS) {
      throw new RangeError(`A benchmark case requires from 1 through ${MAX_BENCHMARK_SYSTEMS} systems.`);
    }
    const systemNames = new Set;
    const systems2 = benchmarkCase.rankings.map((ranking) => {
      const system = checkedLabel(ranking.system, "Benchmark system");
      if (systemNames.has(system))
        throw new Error(`Duplicate benchmark system: ${system}`);
      systemNames.add(system);
      return {
        system,
        metrics: metricsForValidatedRanking(validatedRanking(ranking.ids), judgments, cutoff)
      };
    }).toSorted((left, right) => left.system.localeCompare(right.system));
    const names = systems2.map(({ system }) => system);
    if (expectedSystems === null) {
      expectedSystems = names;
    } else if (names.length !== expectedSystems.length || names.some((name, index) => name !== expectedSystems?.[index])) {
      throw new Error("Every benchmark case must contain the same systems.");
    }
    return { id, queryClass, systems: systems2 };
  }).toSorted((left, right) => left.id.localeCompare(right.id));
  const systems = expectedSystems ?? [];
  const queryClasses = [...new Set(evaluated.map(({ queryClass }) => queryClass))].toSorted((left, right) => left.localeCompare(right));
  return {
    cutoff,
    cases: evaluated,
    overall: aggregateSystems(evaluated, systems),
    byClass: queryClasses.map((queryClass) => {
      const matching = evaluated.filter((item) => item.queryClass === queryClass);
      return {
        queryClass,
        caseCount: matching.length,
        systems: aggregateSystems(matching, systems)
      };
    })
  };
}
function fixtureCase(id, queryClass, judgments, exact, semanticLike) {
  const hybrid = fuseRankedCandidates([
    { name: "exact", weight: 1, ids: exact },
    { name: "semantic-like", weight: 1, ids: semanticLike }
  ]).map(({ id: resultId }) => resultId);
  return {
    id,
    queryClass,
    judgments,
    rankings: [
      { system: "exact", ids: exact },
      { system: "hybrid-rrf", ids: hybrid },
      { system: "semantic-like", ids: semanticLike }
    ]
  };
}
function createSyntheticRankFusionFixture() {
  return [
    fixtureCase("alias-identity", "identity", [{ id: "write-path", relevance: 3 }, { id: "agent-memory", relevance: 1 }], ["write-path", "agent-memory", "durable-notes"], ["durable-notes", "context-window", "write-path", "agent-memory"]),
    fixtureCase("literal-title", "identity", [{ id: "repository-context", relevance: 3 }], ["repository-context", "repository-map"], ["repository-map", "repository-context", "shared-context"]),
    fixtureCase("paraphrased-memory", "conceptual", [{ id: "durable-memory", relevance: 3 }, { id: "write-path", relevance: 1 }], ["chat-history", "context-window", "durable-memory", "write-path"], ["durable-memory", "write-path", "chat-history"]),
    fixtureCase("meaning-without-keywords", "conceptual", [{ id: "retrieval-fusion", relevance: 3 }, { id: "local-search", relevance: 2 }], ["retrieval-fusion", "ranking-noise", "local-search"], ["embedding-noise", "retrieval-fusion", "local-search"]),
    fixtureCase("implementation-decision", "mixed", [
      { id: "decision", relevance: 3 },
      { id: "evidence", relevance: 2 },
      { id: "history", relevance: 1 }
    ], ["decision", "filename-noise", "evidence", "tag-noise", "history"], ["semantic-noise", "evidence", "decision", "history"]),
    fixtureCase("plan-context", "mixed", [{ id: "active-plan", relevance: 3 }, { id: "prior-rationale", relevance: 2 }], ["active-plan", "status-noise", "prior-rationale"], ["concept-noise", "prior-rationale", "active-plan"])
  ];
}
var createRepresentativeRetrievalFixture = createSyntheticRankFusionFixture;

export { evaluateRanking, evaluateRetrievalBenchmark, createSyntheticRankFusionFixture, createRepresentativeRetrievalFixture };
