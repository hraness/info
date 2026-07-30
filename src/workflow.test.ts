import { describe, expect, expectTypeOf, test } from "bun:test";

import {
  defineWorkflow,
  MAX_GIT_WORKFLOW_CONCURRENCY,
  MAX_WORKFLOW_CONCURRENCY,
  MAX_WORKFLOW_OUTPUT_BYTES,
  runWorkflow,
  WorkflowRunError,
  workflowFromUnknown,
} from "./workflow.js";
import type { KnowledgeBaseSearchResult, KnowledgeBaseSession } from "./sdk.js";
import type { WorkflowDefinition } from "./workflow.js";

type WorkflowContract<Definition> =
  Definition extends WorkflowDefinition<
    infer Input,
    infer KnowledgeBase,
    infer Results,
    infer Output
  >
    ? {
      readonly input: Input;
      readonly kb: KnowledgeBase;
      readonly output: Results[Output];
    }
    : never;

function deferred<T = void>() {
  let resolvePromise: (value: T | PromiseLike<T>) => void = () => undefined;
  let rejectPromise: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

describe("workflow definitions", () => {
  test("captures default KB context, dependency results, and final output", () => {
    const workflow = defineWorkflow<{ query: string }>("typed-research")
      .node({
        id: "search",
        resource: "qmd",
        run: ({ input, kb }) => {
          expectTypeOf(input).toEqualTypeOf<{ query: string }>();
          expectTypeOf(kb).toEqualTypeOf<KnowledgeBaseSession>();
          return kb.search(input);
        },
      })
      .node({
        id: "count",
        needs: ["search"],
        run: ({ result }) => {
          expectTypeOf(result("search"))
            .toEqualTypeOf<KnowledgeBaseSearchResult>();
          return result("search").results.length;
        },
      })
      .output("count");

    expectTypeOf<WorkflowContract<typeof workflow>>().toEqualTypeOf<{
      readonly input: { query: string };
      readonly kb: KnowledgeBaseSession;
      readonly output: number;
    }>();
    expect(workflow.output).toBe("count");
  });

  test("preserves direct two-generic object definitions", () => {
    const workflow = defineWorkflow<{ query: string }, { name: string }>({
      id: "direct-object",
      nodes: [{
        id: "search",
        run: ({ input, kb }) => `${kb.name}:${input.query}`,
      }],
      output: "search",
    });

    expect(workflow).toMatchObject({
      kind: "hraness-kb-workflow",
      version: 1,
      id: "direct-object",
      output: "search",
    });
  });

  test("rejects duplicate, unknown, self, and cyclic dependencies before execution", () => {
    const run = () => undefined;
    expect(() => defineWorkflow({
      id: "duplicate",
      nodes: [{ id: "same", run }, { id: "same", run }],
      output: "same",
    })).toThrow("duplicated");
    expect(() => defineWorkflow({
      id: "unknown",
      nodes: [{ id: "node", needs: ["missing"], run }],
      output: "node",
    })).toThrow("unknown node");
    expect(() => defineWorkflow({
      id: "self",
      nodes: [{ id: "node", needs: ["node"], run }],
      output: "node",
    })).toThrow("depend on itself");
    expect(() => defineWorkflow({
      id: "cycle",
      nodes: [
        { id: "first", needs: ["second"], run },
        { id: "second", needs: ["first"], run },
      ],
      output: "second",
    })).toThrow("dependency cycle");
  });

  test("parses a dynamically imported workflow through the owned boundary", () => {
    const parsed = workflowFromUnknown({
      kind: "hraness-kb-workflow",
      version: 1,
      id: "loaded",
      nodes: [{ id: "result", run: () => 42 }],
      output: "result",
    });
    expect(parsed).toMatchObject({ id: "loaded", output: "result" });
    expect(() => workflowFromUnknown({ kind: "other", version: 1 }))
      .toThrow("unsupported");
    expect(() => workflowFromUnknown({
      kind: "hraness-kb-workflow",
      version: 1,
      id: "loaded",
      nodes: [{ id: "result", run: "not a function" }],
      output: "result",
    })).toThrow("malformed");
  });
});

describe("workflow execution", () => {
  test("starts independent nodes together and exposes dependencies to the output node", async () => {
    const release = deferred();
    const bothStarted = deferred();
    const started: string[] = [];
    const markStarted = (id: string) => {
      started.push(id);
      if (started.length === 2) bothStarted.resolve();
    };
    const workflow = defineWorkflow<{ query: string }, { name: string }>(
      "parallel-search",
    )
      .node({
        id: "exact",
        run: async ({ input, kb }) => {
          expectTypeOf(input).toEqualTypeOf<{ query: string }>();
          expectTypeOf(kb).toEqualTypeOf<{ name: string }>();
          markStarted("exact");
          await release.promise;
          return `${kb.name}:${input.query}:exact`;
        },
      })
      .node({
        id: "semantic",
        resource: "qmd",
        run: async ({ input }) => {
          markStarted("semantic");
          await release.promise;
          return `${input.query}:semantic`;
        },
      })
      .node({
        id: "merge",
        needs: ["exact", "semantic"],
        run: ({ input, result }) => {
          expectTypeOf(result("exact")).toEqualTypeOf<string>();
          expectTypeOf(result("semantic")).toEqualTypeOf<string>();
          if (input.query === "__compile-only-missing-node__") {
            // @ts-expect-error Results are keyed by declared dependency IDs.
            result("missing");
          }
          return [result("exact"), result("semantic")] as const;
        },
      })
      .output("merge");
    const running = runWorkflow(workflow, {
      input: { query: "memory" },
      kb: { name: "kb" },
    });
    await bothStarted.promise;
    expect(started).toEqual(["exact", "semantic"]);
    release.resolve();
    const result = await running;
    expect(result.output).toEqual(["kb:memory:exact", "memory:semantic"]);
    expectTypeOf(result.output).toEqualTypeOf<readonly [string, string]>();
    expect(result.trace.map(({ id }) => id)).toEqual([
      "exact",
      "semantic",
      "merge",
    ]);
    expect(result.outputBytes).toBeGreaterThan(0);
  });

  test("exposes only direct dependencies and returns results in declaration order", async () => {
    const releaseFirst = deferred();
    const observerStarted = deferred();
    let visibleResults: readonly string[] = [];
    let rejectedUndeclared = false;
    const workflow = defineWorkflow<undefined, undefined>(
      "dependency-visibility",
    )
      .node({
        id: "first",
        run: async () => {
          await releaseFirst.promise;
          return "first";
        },
      })
      .node({ id: "hidden", run: () => "hidden" })
      .node({ id: "gate", needs: ["hidden"], run: () => "gate" })
      .node({
        id: "observer",
        needs: ["gate"],
        run: ({ result, results }) => {
          visibleResults = [...results.keys()];
          try {
            // @ts-expect-error Undeclared dependencies are unavailable.
            result("hidden");
          } catch (error) {
            rejectedUndeclared = error instanceof Error
              && error.message.includes("not a declared dependency");
          }
          observerStarted.resolve();
          return result("gate");
        },
      })
      .node({
        id: "output",
        needs: ["first", "observer"],
        run: ({ result }) => [result("first"), result("observer")] as const,
      })
      .output("output");
    const running = runWorkflow(workflow, { input: undefined, kb: undefined });
    await observerStarted.promise;
    releaseFirst.resolve();
    const result = await running;
    expect(visibleResults).toEqual(["gate"]);
    expect(rejectedUndeclared).toBeTrue();
    expect([...result.results.keys()]).toEqual([
      "first",
      "hidden",
      "gate",
      "observer",
      "output",
    ]);
    expect(result.output).toEqual(["first", "gate"]);
  });

  test("serializes QMD nodes while allowing another resource to progress", async () => {
    const releaseFirst = deferred();
    const releaseSecond = deferred();
    const firstStarted = deferred();
    const defaultStarted = deferred();
    const secondStarted = deferred();
    const events: string[] = [];
    const workflow = defineWorkflow({
      id: "resource-groups",
      nodes: [
        {
          id: "qmd-first",
          resource: "qmd",
          run: async () => {
            events.push("qmd-first");
            firstStarted.resolve();
            await releaseFirst.promise;
          },
        },
        {
          id: "qmd-second",
          resource: "qmd",
          run: async () => {
            events.push("qmd-second");
            secondStarted.resolve();
            await releaseSecond.promise;
          },
        },
        {
          id: "ordinary",
          run: () => {
            events.push("ordinary");
            defaultStarted.resolve();
          },
        },
      ],
      output: "ordinary",
    });
    const running = runWorkflow(workflow, { input: undefined, kb: undefined });
    await Promise.all([firstStarted.promise, defaultStarted.promise]);
    expect(events).toEqual(["qmd-first", "ordinary"]);
    releaseFirst.resolve();
    await secondStarted.promise;
    expect(events).toEqual(["qmd-first", "ordinary", "qmd-second"]);
    releaseSecond.resolve();
    await running;
  });

  test("stops dependents, lets active siblings settle, and reports the failed node", async () => {
    const siblingStarted = deferred();
    const releaseSibling = deferred();
    let dependentRan = false;
    const workflow = defineWorkflow({
      id: "failure",
      nodes: [
        { id: "broken", run: () => Promise.reject(new Error("boom")) },
        {
          id: "sibling",
          run: async () => {
            siblingStarted.resolve();
            await releaseSibling.promise;
            return "settled";
          },
        },
        {
          id: "dependent",
          needs: ["broken"],
          run: () => {
            dependentRan = true;
          },
        },
      ],
      output: "dependent",
    });
    const running = runWorkflow(workflow, { input: undefined, kb: undefined });
    await siblingStarted.promise;
    releaseSibling.resolve();
    try {
      await running;
      throw new Error("expected workflow failure");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowRunError);
      expect(error).toMatchObject({ kind: "node-failed", node: "broken" });
    }
    expect(dependentRan).toBeFalse();
  });

  test("propagates an external abort signal to running nodes", async () => {
    const started = deferred();
    const controller = new AbortController();
    const workflow = defineWorkflow({
      id: "abort",
      nodes: [{
        id: "waiting",
        run: ({ signal }) => new Promise((_, reject) => {
          started.resolve();
          signal.addEventListener("abort", () => reject(
            signal.reason instanceof Error
              ? signal.reason
              : new Error("Workflow signal aborted."),
          ), { once: true });
        }),
      }],
      output: "waiting",
    });
    const running = runWorkflow(workflow, {
      input: undefined,
      kb: undefined,
      signal: controller.signal,
    });
    await started.promise;
    controller.abort(new Error("stop"));
    try {
      await running;
      throw new Error("expected workflow abort");
    } catch (error) {
      expect(error).toMatchObject({ kind: "aborted" });
    }
  });

  test("bounds global and resource concurrency", async () => {
    const workflow = defineWorkflow({
      id: "bounds",
      nodes: [{ id: "done", run: () => true }],
      output: "done",
    });
    const errors = await Promise.all([
      runWorkflow(workflow, {
        input: undefined,
        kb: undefined,
        concurrency: MAX_WORKFLOW_CONCURRENCY + 1,
      }).then(() => null, (error: unknown) => error),
      runWorkflow(workflow, {
        input: undefined,
        kb: undefined,
        resourceConcurrency: { qmd: 0 },
      }).then(() => null, (error: unknown) => error),
      runWorkflow(workflow, {
        input: undefined,
        kb: undefined,
        resourceConcurrency: { qmd: 2 },
      }).then(() => null, (error: unknown) => error),
      runWorkflow(workflow, {
        input: undefined,
        kb: undefined,
        resourceConcurrency: { git: 0 },
      }).then(() => null, (error: unknown) => error),
      runWorkflow(workflow, {
        input: undefined,
        kb: undefined,
        resourceConcurrency: { git: 1.5 },
      }).then(() => null, (error: unknown) => error),
      runWorkflow(workflow, {
        input: undefined,
        kb: undefined,
        resourceConcurrency: { git: MAX_WORKFLOW_CONCURRENCY + 1 },
      }).then(() => null, (error: unknown) => error),
    ]);
    expect(errors[0]).toBeInstanceOf(Error);
    expect((errors[0] as Error).message).toContain("1 through 8");
    expect(errors[1]).toBeInstanceOf(Error);
    expect((errors[1] as Error).message).toContain("qmd concurrency");
    expect(errors[2]).toBeInstanceOf(Error);
    expect((errors[2] as Error).message).toContain("fixed at 1");
    for (const error of errors.slice(3)) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("git concurrency");
    }
  });

  test("keeps Git work at the hard cap when configured above it", async () => {
    const release = deferred();
    const capReached = deferred();
    let active = 0;
    let maximumActive = 0;
    let started = 0;
    const runGitNode = async () => {
      active += 1;
      started += 1;
      maximumActive = Math.max(maximumActive, active);
      if (active === MAX_GIT_WORKFLOW_CONCURRENCY) capReached.resolve();
      try {
        await release.promise;
        return started;
      } finally {
        active -= 1;
      }
    };
    const workflow = defineWorkflow<undefined, undefined>("git-hard-cap")
      .node({ id: "git-one", resource: "git", run: runGitNode })
      .node({ id: "git-two", resource: "git", run: runGitNode })
      .node({ id: "git-three", resource: "git", run: runGitNode })
      .node({ id: "git-four", resource: "git", run: runGitNode })
      .node({ id: "git-five", resource: "git", run: runGitNode })
      .node({ id: "git-six", resource: "git", run: runGitNode })
      .output("git-six");
    const running = runWorkflow(workflow, {
      input: undefined,
      kb: undefined,
      concurrency: MAX_WORKFLOW_CONCURRENCY,
      resourceConcurrency: { git: MAX_WORKFLOW_CONCURRENCY },
    });
    await capReached.promise;
    expect(started).toBe(MAX_GIT_WORKFLOW_CONCURRENCY);
    release.resolve();
    await running;
    expect(started).toBe(6);
    expect(maximumActive).toBe(MAX_GIT_WORKFLOW_CONCURRENCY);
  });

  test("bounds aggregate structured output and rejects unmeasurable results", async () => {
    const oversized = defineWorkflow({
      id: "output-budget",
      nodes: [
        { id: "first", run: () => "a".repeat(40) },
        { id: "second", needs: ["first"], run: () => "b".repeat(40) },
      ],
      output: "second",
    });
    const outputError = await runWorkflow(oversized, {
      input: undefined,
      kb: undefined,
      maxOutputBytes: 80,
    }).then(() => null, (error: unknown) => error);
    expect(outputError).toBeInstanceOf(WorkflowRunError);
    expect(outputError).toMatchObject({ kind: "output-limit", node: "second" });

    const mutated = defineWorkflow({
      id: "mutated-output-budget",
      nodes: [
        { id: "value", run: () => ({ text: "small" }) },
        {
          id: "mutate",
          needs: ["value"],
          run: ({ result }) => {
            (result("value") as { text: string }).text = "x".repeat(200);
            return true;
          },
        },
      ],
      output: "mutate",
    });
    const mutatedError = await runWorkflow(mutated, {
      input: undefined,
      kb: undefined,
      maxOutputBytes: 80,
    }).then(() => null, (error: unknown) => error);
    expect(mutatedError).toBeInstanceOf(WorkflowRunError);
    expect(mutatedError).toMatchObject({ kind: "output-limit", node: "value" });

    const unmeasurable = defineWorkflow({
      id: "unmeasurable-output",
      nodes: [{ id: "function", run: () => () => undefined }],
      output: "function",
    });
    const serializationError = await runWorkflow(unmeasurable, {
      input: undefined,
      kb: undefined,
    }).then(() => null, (error: unknown) => error);
    expect(serializationError).toBeInstanceOf(WorkflowRunError);
    expect(serializationError).toMatchObject({ kind: "node-failed", node: "function" });
    expect((serializationError as Error).message).toContain("cannot be structurally serialized");

    const invalidLimitWorkflow = defineWorkflow({
      id: "invalid-output-budget",
      nodes: [{ id: "done", run: () => true }],
      output: "done",
    });
    const invalidLimit = await runWorkflow(invalidLimitWorkflow, {
      input: undefined,
      kb: undefined,
      maxOutputBytes: MAX_WORKFLOW_OUTPUT_BYTES + 1,
    }).then(() => null, (error: unknown) => error);
    expect(invalidLimit).toBeInstanceOf(RangeError);
    expect((invalidLimit as Error).message).toContain("output byte limit");
  });
});
