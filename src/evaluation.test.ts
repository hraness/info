import { describe, expect, test } from "bun:test";

import {
  buildRetrievalEvaluationReport,
  pairedBootstrapConfidenceInterval,
  parseRetrievalEvaluationCorpus,
  runRetrievalEvaluation,
  type EvaluationEnvironment,
  type EvaluationRun,
  type RetrievalEvaluationCorpus,
} from "./evaluation.js";

function corpusInput(): unknown {
  return {
    schemaVersion: 1,
    id: "example-memory-v1",
    description: "Frozen repository memory questions",
    frozen: {
      repositoryCommit: "a".repeat(40),
      vaultTree: "b".repeat(40),
      vaultRoot: "kb",
    },
    assessment: {
      rubricVersion: "relevance-0-3-v1",
      assessors: [
        { id: "assessor-a", displayName: "Assessor A" },
        { id: "assessor-b", affiliation: "Independent review" },
      ],
    },
    queries: [
      {
        id: "exact-dev",
        text: "Where is MAX_GIT_PATHS_PER_COMMIT defined?",
        class: "exact-identifier",
        split: "development",
        answer: "answerable",
        inputs: {
          text: "MAX_GIT_PATHS_PER_COMMIT",
          noteId: "notes/git",
          metadata: {
            filters: [{ kind: "equals", path: "type", value: "note" }],
            tags: ["git"],
          },
        },
        qrels: [{ documentId: "notes/git", relevance: 3 }],
        assessorIds: ["assessor-a"],
        adjudication: { status: "not-required" },
      },
      {
        id: "concept-test",
        text: "How does the KB keep semantic state disposable?",
        class: "conceptual-recall",
        split: "test",
        answer: "answerable",
        inputs: {
          text: "semantic state disposable",
          graph: { seeds: ["notes/retrieval"], depth: 1 },
        },
        qrels: [
          { documentId: "notes/retrieval", relevance: 3 },
          { documentId: "plans/hybrid", relevance: 1 },
        ],
        assessorIds: ["assessor-a", "assessor-b"],
        adjudication: {
          status: "resolved",
          adjudicatorId: "assessor-b",
          note: "Resolved the secondary evidence grade.",
        },
      },
      {
        id: "empty-test",
        text: "Which plan mandates a remote vector database?",
        class: "no-answer",
        split: "test",
        answer: "no-answer",
        inputs: { text: "remote vector database" },
        qrels: [{ documentId: "plans/hybrid", relevance: 0 }],
        assessorIds: ["assessor-a"],
        adjudication: { status: "not-required" },
      },
      {
        id: "history-test",
        text: "Why was the generated catalog removed from parallel writes?",
        class: "historical-rationale",
        split: "test",
        answer: "answerable",
        inputs: {
          text: "generated catalog parallel writes",
          context: { repositoryPath: "packages/kb/src/vault.ts" },
          history: { query: "kb/index.md", noteIds: ["plans/routing"] },
        },
        qrels: [{ documentId: "plans/routing", relevance: 2 }],
        assessorIds: ["assessor-a"],
        adjudication: { status: "not-required" },
      },
    ],
  };
}

function corpus(): RetrievalEvaluationCorpus {
  return parseRetrievalEvaluationCorpus(corpusInput());
}

const environment: EvaluationEnvironment = {
  generatedAt: "2026-08-02T12:00:00.000Z",
  runtime: {
    bun: "1.3.14",
    node: "24.0.0",
    os: "macOS 27",
    arch: "arm64",
    hardware: "Apple Silicon test host",
  },
  model: {
    kind: "local",
    id: "embeddinggemma",
    revision: "immutable-revision",
    sha256: "c".repeat(64),
  },
  cache: { state: "warm", fingerprint: "cache-v1" },
  retrievers: [
    { id: "baseline", version: "1", configuration: { mode: "exact" } },
    { id: "candidate", version: "1", configuration: { mode: "hybrid", rerank: false } },
  ],
};

describe("retrieval evaluation corpus", () => {
  test("parses a frozen, independently assessed dev/test corpus from unknown input", () => {
    const parsed = corpus();
    expect(parsed).toMatchObject({
      schemaVersion: 1,
      frozen: {
        repositoryCommit: "a".repeat(40),
        vaultTree: "b".repeat(40),
        vaultRoot: "kb",
      },
      assessment: { rubricVersion: "relevance-0-3-v1" },
    });
    expect(parsed.queries.map(({ id, split, class: queryClass }) => ({ id, split, queryClass })))
      .toEqual([
        { id: "exact-dev", split: "development", queryClass: "exact-identifier" },
        { id: "concept-test", split: "test", queryClass: "conceptual-recall" },
        { id: "empty-test", split: "test", queryClass: "no-answer" },
        { id: "history-test", split: "test", queryClass: "historical-rationale" },
      ]);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.queries)).toBe(true);
    expect(Object.isFrozen(parsed.queries[1]?.qrels)).toBe(true);
    expect(parsed.queries[0]?.inputs).toEqual({
      text: "MAX_GIT_PATHS_PER_COMMIT",
      noteId: "notes/git",
      metadata: {
        filters: [{ kind: "equals", path: "type", value: "note" }],
        tags: ["git"],
      },
    });
  });

  test("rejects mutable-corpus ambiguity and invalid judgment states", () => {
    const badCommit = corpusInput() as Record<string, unknown>;
    badCommit.frozen = {
      repositoryCommit: "main",
      vaultTree: "b".repeat(40),
      vaultRoot: "kb",
    };
    expect(() => parseRetrievalEvaluationCorpus(badCommit)).toThrow(
      "repositoryCommit must be a lowercase Git object ID",
    );

    const badNoAnswer = corpusInput() as { queries: Array<Record<string, unknown>> };
    const query = badNoAnswer.queries[2];
    if (query !== undefined) query.qrels = [{ documentId: "notes/answer", relevance: 1 }];
    expect(() => parseRetrievalEvaluationCorpus(badNoAnswer)).toThrow(
      "no-answer but has a positive relevance judgment",
    );

    const unknownAssessor = corpusInput() as { queries: Array<Record<string, unknown>> };
    const assessed = unknownAssessor.queries[0];
    if (assessed !== undefined) assessed.assessorIds = ["unknown"];
    expect(() => parseRetrievalEvaluationCorpus(unknownAssessor)).toThrow(
      "names undeclared assessor unknown",
    );

    const extraField = corpusInput() as Record<string, unknown>;
    extraField.mutableBranch = "main";
    expect(() => parseRetrievalEvaluationCorpus(extraField)).toThrow(
      "unknown fields: mutableBranch",
    );

    const windowsRoot = corpusInput() as { frozen: Record<string, unknown> };
    windowsRoot.frozen.vaultRoot = "C:\\vault";
    expect(() => parseRetrievalEvaluationCorpus(windowsRoot)).toThrow(
      "vaultRoot must be a confined repository-relative path",
    );

    const escapingContext = corpusInput() as { queries: Array<Record<string, unknown>> };
    escapingContext.queries[0]!.inputs = {
      context: { repositoryPath: "../escape" },
    };
    expect(() => parseRetrievalEvaluationCorpus(escapingContext)).toThrow(
      "context.repositoryPath must be a confined repository-relative path",
    );

    const emptyInputs = corpusInput() as { queries: Array<Record<string, unknown>> };
    emptyInputs.queries[0]!.inputs = { text: undefined };
    expect(() => parseRetrievalEvaluationCorpus(emptyInputs)).toThrow(
      "must define at least one retrieval lane input",
    );
  });
});

describe("injected retrieval execution", () => {
  test("records raw ranks, evidence, diagnostics, failures, and timings without QMD or network access", async () => {
    const times = [0, 10, 10, 30, 30, 35];
    const runs = await runRetrievalEvaluation({
      corpus: corpus(),
      split: "test",
      limit: 5,
      now: () => times.shift() ?? 35,
      retrievers: [{
        id: "injected",
        retrieve: ({ query }) => {
          if (query.id === "history-test") throw new Error("Git fixture unavailable");
          if (query.id === "empty-test") {
            return Promise.resolve({
              status: "degraded",
              hits: [],
              diagnostics: [{
                lane: "semantic",
                status: "unavailable",
                message: "Local model absent",
              }],
              timings: { exactMs: 2 },
              resources: { contextBytes: 0 },
            });
          }
          return Promise.resolve({
            status: "ready",
            hits: [{
              documentId: "notes/retrieval",
              rank: 1,
              score: 0.92,
              evidence: {
                lane: "qmd-hybrid",
                explanation: { keyword: true, vector: true },
              },
            }],
            diagnostics: [{ lane: "qmd", status: "ready" }],
            timings: { qmdMs: 8, projectionMs: 1 },
            resources: { peakRssBytes: 1_024, cpuUserMs: 3 },
          });
        },
      }],
    });

    expect(runs).toHaveLength(3);
    expect(runs[0]).toMatchObject({
      queryId: "concept-test",
      status: "ready",
      hits: [{
        documentId: "notes/retrieval",
        rank: 1,
        evidence: { lane: "qmd-hybrid" },
      }],
      diagnostics: [{ lane: "qmd", status: "ready" }],
      timing: { elapsedMs: 10, backend: { qmdMs: 8, projectionMs: 1 } },
      resources: { cpuUserMs: 3, peakRssBytes: 1_024 },
    });
    expect(runs[1]).toMatchObject({
      queryId: "empty-test",
      status: "degraded",
      timing: { elapsedMs: 20 },
    });
    expect(runs[2]).toMatchObject({
      queryId: "history-test",
      status: "failed",
      failure: { kind: "exception", message: "Git fixture unavailable" },
      timing: { elapsedMs: 5 },
    });
  });

  test("redacts machine-local paths from evidence, diagnostics, and failures", async () => {
    const testCorpus = corpus();
    const ready = await runRetrievalEvaluation({
      corpus: testCorpus,
      split: "development",
      retrievers: [{
        id: "paths",
        retrieve: () => Promise.resolve({
          status: "ready",
          hits: [{
            documentId: "notes/retrieval",
            rank: 1,
            evidence: {
              mac: "/Users/alice/project/file.ts",
              linux: "/home/bob/project/file.ts",
              windows: "C:\\Users\\Carol\\project\\file.ts",
              temporary: "/private/tmp/evaluation/report.json",
              darwinTemporary: "/var/folders/aa/bb/T/evaluation/report.json",
              canonicalDarwinTemporary:
                "/private/var/folders/aa/bb/T/evaluation/report.json",
              temporaryFileUrl:
                "file:///private/var/folders/aa/bb/T/evaluation/report.json",
              windowsForward: "C:/Users/Dana/project/file.ts",
              rootHome: "/root/project/file.ts",
              rootFileUrl: "FILE:///root/project/file.ts",
              nested: [{ path: "/Users/erin/project/file.ts" }],
              url: "https://example.com/Users/alice/profile",
              relative: "Users/alice/project/file.ts",
            },
          }],
          diagnostics: [{
            lane: "paths",
            status: "ready",
            message: "Loaded /Users/alice/project/file.ts",
          }],
        }),
      }],
    });
    expect(ready[0]).toMatchObject({
      hits: [{
        evidence: {
          mac: "<home>/project/file.ts",
          linux: "<home>/project/file.ts",
          windows: "<home>\\project\\file.ts",
          temporary: "<temporary>/evaluation/report.json",
          darwinTemporary: "<temporary>/evaluation/report.json",
          canonicalDarwinTemporary: "<temporary>/evaluation/report.json",
          temporaryFileUrl: "file://<temporary>/evaluation/report.json",
          windowsForward: "<home>/project/file.ts",
          rootHome: "<home>/project/file.ts",
          rootFileUrl: "file://<home>/project/file.ts",
          nested: [{ path: "<home>/project/file.ts" }],
          url: "https://example.com/Users/alice/profile",
          relative: "Users/alice/project/file.ts",
        },
      }],
      diagnostics: [{ message: "Loaded <home>/project/file.ts" }],
    });

    const failed = await runRetrievalEvaluation({
      corpus: testCorpus,
      split: "development",
      retrievers: [{
        id: "path-failure",
        retrieve: () => {
          throw new Error("Failed below /Users/alice/project");
        },
      }],
    });
    expect(failed[0]?.failure?.message).toBe("Failed below <home>/project");
  });

  test("turns malformed retriever output into a typed run failure", async () => {
    const runs = await runRetrievalEvaluation({
      corpus: corpus(),
      split: "development",
      retrievers: [{
        id: "invalid",
        retrieve: () => Promise.resolve({
          status: "ready",
          hits: [
            { documentId: "a", rank: 1 },
            { documentId: "b", rank: 1 },
          ],
        }),
      }],
    });
    expect(runs).toMatchObject([{
      status: "failed",
      failure: { kind: "invalid-result", message: "retriever result ranks must be unique." },
    }]);
  });

  test("rejects invalid resource counters at the injected boundary", async () => {
    const runs = await runRetrievalEvaluation({
      corpus: corpus(),
      split: "development",
      retrievers: [{
        id: "invalid-resources",
        retrieve: () => Promise.resolve({
          status: "ready",
          hits: [],
          resources: { peakRssBytes: -1 },
        }),
      }],
    });
    expect(runs).toMatchObject([{
      status: "failed",
      failure: {
        kind: "invalid-result",
        message: "retriever result resources peakRssBytes must be a non-negative finite number.",
      },
    }]);
  });

  test("aborts a retriever that exceeds the bounded wall-clock budget", async () => {
    let observedAbort = false;
    const runs = await runRetrievalEvaluation({
      corpus: corpus(),
      split: "development",
      timeoutMs: 5,
      retrievers: [{
        id: "blocked",
        retrieve: ({ signal }) => new Promise(() => {
          signal.addEventListener("abort", () => {
            observedAbort = true;
          }, { once: true });
        }),
      }],
    });
    expect(observedAbort).toBe(true);
    expect(runs).toMatchObject([{
      status: "failed",
      failure: {
        kind: "timeout",
        message: "Retriever exceeded the 5-millisecond limit.",
      },
    }]);
  });
});

describe("retrieval report and statistical evidence", () => {
  test("produces deterministic paired bootstrap intervals", () => {
    const pairs = [
      { baseline: 0.2, candidate: 0.4 },
      { baseline: 0.5, candidate: 0.75 },
      { baseline: 0.8, candidate: 0.7 },
      { baseline: 0.1, candidate: 0.3 },
    ];
    const first = pairedBootstrapConfidenceInterval(pairs, {
      seed: 42,
      resamples: 2_000,
    });
    const second = pairedBootstrapConfidenceInterval(pairs, {
      seed: 42,
      resamples: 2_000,
    });
    expect(first).toEqual(second);
    expect(first.observedDifference).toBeCloseTo(0.1375, 10);
    expect(first.lower).toBeLessThanOrEqual(first.observedDifference);
    expect(first.upper).toBeGreaterThanOrEqual(first.observedDifference);
  });

  test("builds a canonical raw report with quality, percentiles, model, and cache metadata", () => {
    const run = (
      retrieverId: string,
      queryId: string,
      queryClass: EvaluationRun["queryClass"],
      status: EvaluationRun["status"],
      elapsedMs: number,
      hits: EvaluationRun["hits"],
    ): EvaluationRun => ({
      retrieverId,
      queryId,
      queryClass,
      split: "test",
      status,
      hits,
      diagnostics: [],
      timing: { elapsedMs, backend: {} },
      resources: {},
    });
    const runs: EvaluationRun[] = [
      run("baseline", "concept-test", "conceptual-recall", "ready", 10, [
        { documentId: "notes/retrieval", rank: 1 },
      ]),
      run("baseline", "empty-test", "no-answer", "ready", 20, []),
      run("baseline", "history-test", "historical-rationale", "ready", 5, []),
      run("candidate", "concept-test", "conceptual-recall", "ready", 30, [
        {
          documentId: "notes/retrieval",
          rank: 1,
          evidence: { path: "/Users/alice/project/note.md" },
        },
        { documentId: "plans/hybrid", rank: 2 },
      ]),
      run("candidate", "empty-test", "no-answer", "ready", 40, []),
      run("candidate", "history-test", "historical-rationale", "ready", 25, [
        { documentId: "plans/routing", rank: 1 },
      ]),
    ];
    const report = buildRetrievalEvaluationReport({
      corpus: corpus(),
      runs,
      environment,
      cutoff: 3,
      baselineRetrieverId: "baseline",
      bootstrapSeed: 9,
      bootstrapResamples: 500,
    });

    expect(report).toMatchObject({
      schemaVersion: 1,
      split: "test",
      queryCount: 3,
      cutoff: 3,
      environment: {
        model: { kind: "local", id: "embeddinggemma" },
        cache: { state: "warm", fingerprint: "cache-v1" },
      },
      summaries: [
        {
          retrieverId: "baseline",
          runs: 3,
          latencyMs: { p50: 10, p90: 20, p95: 20, p99: 20 },
          metrics: { recall: 0.25, noAnswerAccuracy: 1 },
        },
        {
          retrieverId: "candidate",
          runs: 3,
          latencyMs: { p50: 30, p90: 40, p95: 40, p99: 40 },
          metrics: { recall: 1, reciprocalRank: 1, noAnswerAccuracy: 1 },
        },
      ],
    });
    expect(report.comparisons.map(({ metric }) => metric)).toEqual([
      "recall",
      "reciprocalRank",
      "ndcg",
      "noAnswerAccuracy",
    ]);
    expect(report.comparisons.find(({ metric }) => metric === "recall")?.interval)
      .toMatchObject({ pairs: 2, observedDifference: 0.75 });
    expect(report.runs.find(({ retrieverId, queryId }) =>
      retrieverId === "candidate" && queryId === "concept-test")?.hits[0]?.evidence)
      .toEqual({ path: "<home>/project/note.md" });
    expect(JSON.stringify(buildRetrievalEvaluationReport({
      corpus: corpus(),
      runs: [...runs].reverse(),
      environment,
      cutoff: 3,
      baselineRetrieverId: "baseline",
      bootstrapSeed: 9,
      bootstrapResamples: 500,
    }))).toBe(JSON.stringify(report));
  });

  test("redacts diagnostics and failures from caller-supplied report runs", () => {
    const report = buildRetrievalEvaluationReport({
      corpus: corpus(),
      runs: [{
        retrieverId: "direct",
        queryId: "exact-dev",
        queryClass: "exact-identifier",
        split: "development",
        status: "failed",
        hits: [],
        diagnostics: [{
          lane: "direct",
          status: "degraded",
          message: "Read /root/project/index.md",
        }],
        timing: { elapsedMs: 1, backend: {} },
        resources: {},
        failure: {
          kind: "exception",
          message: "Failed at /private/tmp/evaluation/index.sqlite",
        },
      }],
      environment: {
        ...environment,
        retrievers: [{ id: "direct", version: "1", configuration: {} }],
      },
      baselineRetrieverId: "direct",
    });

    expect(report.runs[0]).toMatchObject({
      diagnostics: [{ message: "Read <home>/project/index.md" }],
      failure: { message: "Failed at <temporary>/evaluation/index.sqlite" },
    });
  });

  test("scores unavailable lanes as failures across a complete query matrix", () => {
    const unavailableRun = (
      queryId: string,
      queryClass: EvaluationRun["queryClass"],
    ): EvaluationRun => ({
      retrieverId: "baseline",
      queryId,
      queryClass,
      split: "test",
      status: "unavailable",
      hits: [],
      diagnostics: [{ lane: "qmd", status: "unavailable" }],
      timing: { elapsedMs: 4, backend: {} },
      resources: {},
    });
    const report = buildRetrievalEvaluationReport({
      corpus: corpus(),
      runs: [
        unavailableRun("concept-test", "conceptual-recall"),
        unavailableRun("empty-test", "no-answer"),
        unavailableRun("history-test", "historical-rationale"),
      ],
      environment: {
        ...environment,
        model: { kind: "none", reason: "Exact-only unavailable fixture" },
        retrievers: [environment.retrievers[0]!],
      },
    });
    expect(report.summaries[0]?.metrics).toMatchObject({
      recall: 0,
      reciprocalRank: 0,
      ndcg: 0,
      noAnswerAccuracy: 0,
    });
    expect(report.runs.find(({ queryId }) => queryId === "empty-test")?.metrics.noAnswerAccuracy)
      .toBe(0);
  });

  test("rejects incomplete or cherry-picked retriever matrices", () => {
    expect(() => buildRetrievalEvaluationReport({
      corpus: corpus(),
      runs: [{
        retrieverId: "baseline",
        queryId: "empty-test",
        queryClass: "no-answer",
        split: "test",
        status: "ready",
        hits: [],
        diagnostics: [],
        timing: { elapsedMs: 4, backend: {} },
        resources: {},
      }],
      environment: {
        ...environment,
        retrievers: [environment.retrievers[0]!],
      },
    })).toThrow("must contain exactly the 3 test query runs");
  });
});
