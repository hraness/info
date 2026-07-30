import { describe, expect, test } from "bun:test";

import {
  createRepresentativeRetrievalFixture,
  evaluateRanking,
  evaluateRetrievalBenchmark,
  type RetrievalBenchmarkCase,
} from "./benchmark.js";

describe("retrieval metrics", () => {
  test("computes Recall@K, MRR@K, and graded nDCG@K", () => {
    const metrics = evaluateRanking(
      ["noise", "high", "low", "outside-cutoff"],
      [
        { id: "high", relevance: 3 },
        { id: "low", relevance: 1 },
        { id: "missing", relevance: 2 },
      ],
      3,
    );
    const expectedDcg = (7 / Math.log2(3)) + (1 / Math.log2(4));
    const idealDcg = 7 + (3 / Math.log2(3)) + (1 / Math.log2(4));
    expect(metrics.recallAtK).toBe(2 / 3);
    expect(metrics.mrrAtK).toBe(1 / 2);
    expect(metrics.ndcgAtK).toBeCloseTo(expectedDcg / idealDcg, 12);
  });

  test("returns zero when the cutoff contains no judged result", () => {
    expect(evaluateRanking(
      ["noise"],
      [{ id: "relevant", relevance: 2 }],
      1,
    )).toEqual({ recallAtK: 0, mrrAtK: 0, ndcgAtK: 0 });
  });
});

describe("bounded benchmark evaluation", () => {
  test("is deterministic across case, system, and judgment input order", () => {
    const fixture = createRepresentativeRetrievalFixture();
    const reordered = fixture.toReversed().map((benchmarkCase) => ({
      ...benchmarkCase,
      judgments: benchmarkCase.judgments.toReversed(),
      rankings: benchmarkCase.rankings.toReversed(),
    }));
    expect(evaluateRetrievalBenchmark(reordered, { cutoff: 3 }))
      .toEqual(evaluateRetrievalBenchmark(fixture, { cutoff: 3 }));
  });

  test("requires comparable systems and rejects ambiguous or unbounded inputs", () => {
    const valid: RetrievalBenchmarkCase = {
      id: "query",
      queryClass: "identity",
      judgments: [{ id: "answer", relevance: 1 }],
      rankings: [{ system: "exact", ids: ["answer"] }],
    };
    expect(() => evaluateRetrievalBenchmark([])).toThrow("from 1 through 500");
    expect(() => evaluateRetrievalBenchmark([valid], { cutoff: 101 }))
      .toThrow("1 through 100");
    expect(() => evaluateRetrievalBenchmark([
      valid,
      { ...valid, id: "query-2", rankings: [{ system: "semantic", ids: [] }] },
    ])).toThrow("same systems");
    expect(() => evaluateRetrievalBenchmark([{
      ...valid,
      rankings: [{ system: "exact", ids: ["answer", "answer"] }],
    }])).toThrow("Duplicate ranking result id");
    expect(() => evaluateRetrievalBenchmark([{
      ...valid,
      judgments: [{ id: "answer", relevance: 11 }],
    }])).toThrow("1 through 10");
  });
});

describe("representative hybrid regression fixture", () => {
  test("shows aggregate complementarity without requiring either lane to win every class", () => {
    const report = evaluateRetrievalBenchmark(
      createRepresentativeRetrievalFixture(),
      { cutoff: 3 },
    );
    const overall = Object.fromEntries(
      report.overall.map(({ system, metrics }) => [system, metrics]),
    );
    expect(overall["hybrid-rrf"]?.ndcgAtK)
      .toBeGreaterThan(overall.exact?.ndcgAtK ?? 1);
    expect(overall["hybrid-rrf"]?.ndcgAtK)
      .toBeGreaterThan(overall["semantic-like"]?.ndcgAtK ?? 1);
    expect(overall["hybrid-rrf"]?.recallAtK)
      .toBeGreaterThanOrEqual(overall.exact?.recallAtK ?? 1);
    expect(overall["hybrid-rrf"]?.recallAtK)
      .toBeGreaterThanOrEqual(overall["semantic-like"]?.recallAtK ?? 1);

    const classMetrics = (queryClass: string, system: string) =>
      report.byClass
        .find((item) => item.queryClass === queryClass)
        ?.systems.find((item) => item.system === system)?.metrics;
    expect(classMetrics("identity", "exact")?.ndcgAtK)
      .toBeGreaterThan(classMetrics("identity", "semantic-like")?.ndcgAtK ?? 1);
    expect(classMetrics("conceptual", "semantic-like")?.ndcgAtK)
      .toBeGreaterThan(classMetrics("conceptual", "exact")?.ndcgAtK ?? 1);
    expect(report.cases).toHaveLength(6);
  });
});
