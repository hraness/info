import { serialize } from "node:v8";

import type { KnowledgeBaseSession } from "./sdk.js";

export const MAX_WORKFLOW_NODES = 64;
export const MAX_WORKFLOW_CONCURRENCY = 8;
export const MAX_GIT_WORKFLOW_CONCURRENCY = 4;
export const DEFAULT_WORKFLOW_OUTPUT_BYTES = 16 * 1_024 * 1_024;
export const MAX_WORKFLOW_OUTPUT_BYTES = 64 * 1_024 * 1_024;

const workflowIdPattern = /^[a-z][a-z0-9-]{0,63}$/u;

export type WorkflowResource = "default" | "git" | "qmd";

type DefaultWorkflowResults = Readonly<Record<string, unknown>>;
type WorkflowResultId<Results extends object> = Extract<keyof Results, string>;
type WorkflowResultValue<Results extends object> = Results[WorkflowResultId<Results>];

export type WorkflowNodeContext<
  Input,
  KnowledgeBase,
  Results extends object = DefaultWorkflowResults,
> = {
  readonly input: Input;
  readonly kb: KnowledgeBase;
  readonly signal: AbortSignal;
  readonly results: ReadonlyMap<WorkflowResultId<Results>, WorkflowResultValue<Results>>;
  readonly result: <Id extends WorkflowResultId<Results>>(id: Id) => Results[Id];
};

export type WorkflowNode<
  Input,
  KnowledgeBase,
  Results extends object = DefaultWorkflowResults,
> = {
  readonly [Id in WorkflowResultId<Results>]: {
    readonly id: Id;
    readonly needs?: readonly WorkflowResultId<Results>[];
    readonly resource?: WorkflowResource;
    readonly run: (
      context: WorkflowNodeContext<Input, KnowledgeBase, Results>,
    ) => Results[Id] | Promise<Results[Id]>;
  };
}[WorkflowResultId<Results>];

export type WorkflowDefinition<
  Input,
  KnowledgeBase,
  Results extends object = DefaultWorkflowResults,
  Output extends WorkflowResultId<Results> = WorkflowResultId<Results>,
> = {
  readonly kind: "hraness-kb-workflow";
  readonly version: 1;
  readonly id: string;
  readonly nodes: readonly WorkflowNode<Input, KnowledgeBase, Results>[];
  readonly output: Output;
};

export type WorkflowSpecification<
  Input,
  KnowledgeBase,
  Results extends object = DefaultWorkflowResults,
  Output extends WorkflowResultId<Results> = WorkflowResultId<Results>,
> = Omit<
  WorkflowDefinition<Input, KnowledgeBase, Results, Output>,
  "kind" | "version"
>;

type WorkflowBuilderNode<
  Input,
  KnowledgeBase,
  Results extends object,
  Id extends string,
  Needs extends readonly WorkflowResultId<Results>[],
  Returned,
> = {
  readonly id: Id & (Id extends WorkflowResultId<Results> ? never : unknown);
  readonly needs?: Needs;
  readonly resource?: WorkflowResource;
  readonly run: (
    context: WorkflowNodeContext<
      Input,
      KnowledgeBase,
      Pick<Results, Needs[number]>
    >,
  ) => Returned;
};

export type WorkflowBuilder<
  Input,
  KnowledgeBase = KnowledgeBaseSession,
  Results extends object = Readonly<Record<never, never>>,
> = {
  readonly node: <
    const Id extends string,
    Returned,
    const Needs extends readonly WorkflowResultId<Results>[] = readonly [],
  >(
    node: WorkflowBuilderNode<
      Input,
      KnowledgeBase,
      Results,
      Id,
      Needs,
      Returned
    >,
  ) => WorkflowBuilder<
    Input,
    KnowledgeBase,
    Results & Readonly<Record<Id, Awaited<Returned>>>
  >;
  readonly output: <Output extends WorkflowResultId<Results>>(
    output: Output,
  ) => WorkflowDefinition<Input, KnowledgeBase, Results, Output>;
};

export type WorkflowNodeTrace = {
  readonly id: string;
  readonly needs: readonly string[];
  readonly resource: WorkflowResource;
  readonly status: "completed";
};

export type WorkflowRunResult<
  Results extends object = DefaultWorkflowResults,
  Output extends WorkflowResultId<Results> = WorkflowResultId<Results>,
> = {
  readonly workflow: string;
  readonly outputNode: Output;
  readonly output: Results[Output];
  /** Sum of each completed node result's structured-serialization bytes. */
  readonly outputBytes: number;
  readonly trace: readonly WorkflowNodeTrace[];
  readonly results: ReadonlyMap<WorkflowResultId<Results>, WorkflowResultValue<Results>>;
};

export type WorkflowRunOptions<Input, KnowledgeBase> = {
  readonly input: Input;
  readonly kb: KnowledgeBase;
  readonly concurrency?: number;
  readonly resourceConcurrency?: Partial<Readonly<Record<WorkflowResource, number>>>;
  /** Aggregate structured-serialization bytes across completed node results. */
  readonly maxOutputBytes?: number;
  readonly signal?: AbortSignal;
};

export type WorkflowFailureKind = "aborted" | "node-failed" | "output-limit";

export class WorkflowRunError extends Error {
  readonly kind: WorkflowFailureKind;
  readonly node?: string;

  constructor(
    kind: WorkflowFailureKind,
    message: string,
    options: ErrorOptions & { readonly node?: string } = {},
  ) {
    super(message, options);
    this.name = "WorkflowRunError";
    this.kind = kind;
    if (options.node !== undefined) this.node = options.node;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function needsFor<Input, KnowledgeBase, Results extends object>(
  node: WorkflowNode<Input, KnowledgeBase, Results>,
): readonly WorkflowResultId<Results>[] {
  return node.needs ?? [];
}

function validateWorkflowId(id: string, label: string): void {
  if (!workflowIdPattern.test(id)) {
    throw new Error(
      `${label} must start with a lowercase letter and contain at most 64 lowercase letters, digits, or hyphens.`,
    );
  }
}

function validateWorkflow<
  Input,
  KnowledgeBase,
  Results extends object,
  Output extends WorkflowResultId<Results>,
>(
  definition: WorkflowDefinition<Input, KnowledgeBase, Results, Output>,
): void {
  validateWorkflowId(definition.id, "Workflow id");
  if (definition.nodes.length < 1 || definition.nodes.length > MAX_WORKFLOW_NODES) {
    throw new RangeError(
      `A workflow must contain from 1 through ${MAX_WORKFLOW_NODES} nodes.`,
    );
  }
  const nodesById = new Map<string, WorkflowNode<Input, KnowledgeBase, Results>>();
  for (const node of definition.nodes) {
    validateWorkflowId(node.id, "Workflow node id");
    if (nodesById.has(node.id)) {
      throw new Error(`Workflow node id ${JSON.stringify(node.id)} is duplicated.`);
    }
    if (typeof node.run !== "function") {
      throw new Error(`Workflow node ${JSON.stringify(node.id)} must define run().`);
    }
    const needs = needsFor(node);
    if (new Set(needs).size !== needs.length) {
      throw new Error(
        `Workflow node ${JSON.stringify(node.id)} repeats a dependency.`,
      );
    }
    nodesById.set(node.id, node);
  }
  if (!nodesById.has(definition.output)) {
    throw new Error(
      `Workflow output node ${JSON.stringify(definition.output)} does not exist.`,
    );
  }
  for (const node of definition.nodes) {
    for (const dependency of needsFor(node)) {
      if (!nodesById.has(dependency)) {
        throw new Error(
          `Workflow node ${JSON.stringify(node.id)} depends on unknown node ${JSON.stringify(dependency)}.`,
        );
      }
      if (dependency === node.id) {
        throw new Error(
          `Workflow node ${JSON.stringify(node.id)} cannot depend on itself.`,
        );
      }
    }
  }

  const remaining = new Set(nodesById.keys());
  const completed = new Set<string>();
  while (remaining.size > 0) {
    const ready = definition.nodes.filter((node) =>
      remaining.has(node.id)
      && needsFor(node).every((dependency) => completed.has(dependency)));
    if (ready.length === 0) {
      throw new Error(
        `Workflow contains a dependency cycle among: ${[...remaining].join(", ")}.`,
      );
    }
    for (const node of ready) {
      remaining.delete(node.id);
      completed.add(node.id);
    }
  }
}

function createWorkflowBuilder<
  Input,
  KnowledgeBase,
  Results extends object,
>(
  id: string,
  nodes: readonly WorkflowNode<Input, KnowledgeBase, Results>[],
): WorkflowBuilder<Input, KnowledgeBase, Results> {
  const builder: WorkflowBuilder<Input, KnowledgeBase, Results> = {
    node: <
      const Id extends string,
      Returned,
      const Needs extends readonly WorkflowResultId<Results>[] = readonly [],
    >(
      node: WorkflowBuilderNode<
        Input,
        KnowledgeBase,
        Results,
        Id,
        Needs,
        Returned
      >,
    ) => createWorkflowBuilder<
      Input,
      KnowledgeBase,
      Results & Readonly<Record<Id, Awaited<Returned>>>
    >(
      id,
      [...nodes, node] as unknown as readonly WorkflowNode<
        Input,
        KnowledgeBase,
        Results & Readonly<Record<Id, Awaited<Returned>>>
      >[],
    ),
    output: (output) => defineWorkflow({
      id,
      nodes,
      output,
    }),
  };
  return builder;
}

/** Define a finite trusted TypeScript workflow. Runtime validation is repeated at execution. */
export function defineWorkflow<
  Input,
  KnowledgeBase = KnowledgeBaseSession,
>(id: string): WorkflowBuilder<Input, KnowledgeBase>;
export function defineWorkflow<Input, KnowledgeBase>(
  specification: WorkflowSpecification<Input, KnowledgeBase>,
): WorkflowDefinition<Input, KnowledgeBase>;
export function defineWorkflow<
  Input,
  KnowledgeBase,
  Results extends object,
  Output extends WorkflowResultId<Results>,
>(
  specification: WorkflowSpecification<Input, KnowledgeBase, Results, Output>,
): WorkflowDefinition<Input, KnowledgeBase, Results, Output>;
export function defineWorkflow<
  Input,
  KnowledgeBase,
  Results extends object,
  Output extends WorkflowResultId<Results>,
>(
  specification: string | WorkflowSpecification<
    Input,
    KnowledgeBase,
    Results,
    Output
  >,
):
  | WorkflowDefinition<Input, KnowledgeBase, Results, Output>
  | WorkflowBuilder<Input, KnowledgeBase> {
  if (typeof specification === "string") {
    return createWorkflowBuilder<Input, KnowledgeBase, Readonly<Record<never, never>>>(
      specification,
      [],
    );
  }
  const definition: WorkflowDefinition<Input, KnowledgeBase, Results, Output> = {
    kind: "hraness-kb-workflow",
    version: 1,
    ...specification,
  };
  validateWorkflow(definition);
  return definition;
}

/** Validate a dynamically imported code-mode value before executing it. */
export function workflowFromUnknown(
  value: unknown,
): WorkflowDefinition<unknown, unknown> {
  if (!isRecord(value)) throw new Error("Workflow export must be an object.");
  if (value.kind !== "hraness-kb-workflow" || value.version !== 1) {
    throw new Error("Workflow export has an unsupported kind or version.");
  }
  if (
    typeof value.id !== "string"
    || typeof value.output !== "string"
    || !Array.isArray(value.nodes)
  ) {
    throw new Error("Workflow export has malformed id, output, or nodes.");
  }
  const nodes: WorkflowNode<unknown, unknown>[] = value.nodes.map((item, index) => {
    if (!isRecord(item) || typeof item.id !== "string") {
      throw new Error(`Workflow export node ${index} is malformed.`);
    }
    const run = item.run;
    if (typeof run !== "function") {
      throw new Error(`Workflow export node ${index} is malformed.`);
    }
    const needs = item.needs;
    if (needs !== undefined && (!Array.isArray(needs) || needs.some((entry) => typeof entry !== "string"))) {
      throw new Error(`Workflow export node ${index}.needs must be an array of strings.`);
    }
    const resource = item.resource;
    if (resource !== undefined && resource !== "default" && resource !== "git" && resource !== "qmd") {
      throw new Error(`Workflow export node ${index}.resource is invalid.`);
    }
    return {
      id: item.id,
      ...(needs === undefined ? {} : { needs }),
      ...(resource === undefined ? {} : { resource }),
      run: (context) => {
        const returned: unknown = Reflect.apply(run, undefined, [context]);
        return returned;
      },
    };
  });
  const definition: WorkflowDefinition<unknown, unknown> = {
    kind: "hraness-kb-workflow",
    version: 1,
    id: value.id,
    nodes,
    output: value.output,
  };
  validateWorkflow(definition);
  return definition;
}

function checkedConcurrency(value: number | undefined): number {
  const concurrency = value ?? 4;
  if (
    !Number.isSafeInteger(concurrency)
    || concurrency < 1
    || concurrency > MAX_WORKFLOW_CONCURRENCY
  ) {
    throw new RangeError(
      `Workflow concurrency must be an integer from 1 through ${MAX_WORKFLOW_CONCURRENCY}.`,
    );
  }
  return concurrency;
}

function resourceLimits(
  concurrency: number,
  configured: WorkflowRunOptions<unknown, unknown>["resourceConcurrency"],
): Readonly<Record<WorkflowResource, number>> {
  const limits: Record<WorkflowResource, number> = {
    default: concurrency,
    git: Math.min(MAX_GIT_WORKFLOW_CONCURRENCY, concurrency),
    qmd: 1,
  };
  for (const resource of ["default", "git", "qmd"] as const) {
    const value = configured?.[resource];
    if (value === undefined) continue;
    if (resource === "qmd" && value !== 1) {
      throw new RangeError("Workflow qmd concurrency is fixed at 1.");
    }
    if (!Number.isSafeInteger(value) || value < 1 || value > MAX_WORKFLOW_CONCURRENCY) {
      throw new RangeError(
        `Workflow ${resource} concurrency must be an integer from 1 through ${MAX_WORKFLOW_CONCURRENCY}.`,
      );
    }
    limits[resource] = resource === "git"
      ? Math.min(value, concurrency, MAX_GIT_WORKFLOW_CONCURRENCY)
      : Math.min(value, concurrency);
  }
  return limits;
}

function checkedOutputBytes(value: number | undefined): number {
  const maximum = value ?? DEFAULT_WORKFLOW_OUTPUT_BYTES;
  if (
    !Number.isSafeInteger(maximum)
    || maximum < 1
    || maximum > MAX_WORKFLOW_OUTPUT_BYTES
  ) {
    throw new RangeError(
      `Workflow output byte limit must be an integer from 1 through ${MAX_WORKFLOW_OUTPUT_BYTES}.`,
    );
  }
  return maximum;
}

function structuredOutputBytes(value: unknown, node: string): number {
  try {
    return serialize(value).byteLength;
  } catch (error: unknown) {
    throw new WorkflowRunError(
      "node-failed",
      `Workflow node ${JSON.stringify(node)} returned a result that cannot be structurally serialized.`,
      { node, cause: error },
    );
  }
}

type NodeOutcome =
  | { readonly ok: true; readonly id: string; readonly value: unknown }
  | { readonly ok: false; readonly id: string; readonly error: unknown };

function abortedError(): WorkflowRunError {
  return new WorkflowRunError("aborted", "Workflow execution was aborted.");
}

/** Execute ready nodes concurrently while keeping QMD and Git resource groups bounded. */
export async function runWorkflow<
  Input,
  KnowledgeBase,
  Results extends object,
  Output extends WorkflowResultId<Results>,
>(
  definition: WorkflowDefinition<Input, KnowledgeBase, Results, Output>,
  options: WorkflowRunOptions<Input, KnowledgeBase>,
): Promise<WorkflowRunResult<Results, Output>> {
  validateWorkflow(definition);
  const concurrency = checkedConcurrency(options.concurrency);
  const limits = resourceLimits(concurrency, options.resourceConcurrency);
  const outputLimit = checkedOutputBytes(options.maxOutputBytes);
  if (options.signal?.aborted === true) throw abortedError();

  const controller = new AbortController();
  let abortedByCaller = false;
  const abort = () => {
    abortedByCaller = true;
    controller.abort(options.signal?.reason);
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  const pending = new Set(definition.nodes.map(({ id }) => id));
  const completed = new Set<string>();
  const values = new Map<
    WorkflowResultId<Results>,
    WorkflowResultValue<Results>
  >();
  const active = new Map<string, Promise<NodeOutcome>>();
  const activeResource = new Map<string, WorkflowResource>();
  const resourceCounts: Record<WorkflowResource, number> = {
    default: 0,
    git: 0,
    qmd: 0,
  };
  let failure: WorkflowRunError | undefined;
  let outputBytes = 0;

  const completedValue = <Id extends WorkflowResultId<Results>>(id: Id): Results[Id] => {
    if (!values.has(id)) {
      throw new Error(
        `Workflow result ${JSON.stringify(id)} is unavailable after its dependency completed.`,
      );
    }
    return values.get(id) as Results[Id];
  };

  const launch = (node: WorkflowNode<Input, KnowledgeBase, Results>): void => {
    const resource = node.resource ?? "default";
    pending.delete(node.id);
    resourceCounts[resource] += 1;
    activeResource.set(node.id, resource);
    const needs = needsFor(node);
    const allowedResults = new Set(needs);
    const dependencyResults = new Map<
      WorkflowResultId<Results>,
      WorkflowResultValue<Results>
    >(needs.map((id) => [id, completedValue(id)] as const));
    const context: WorkflowNodeContext<Input, KnowledgeBase, Results> = {
      input: options.input,
      kb: options.kb,
      signal: controller.signal,
      results: dependencyResults,
      result: <Id extends WorkflowResultId<Results>>(id: Id): Results[Id] => {
        if (!allowedResults.has(id)) {
          throw new Error(
            `Workflow result ${JSON.stringify(id)} is not a declared dependency of ${JSON.stringify(node.id)}.`,
          );
        }
        return dependencyResults.get(id) as Results[Id];
      },
    };
    const outcome: Promise<NodeOutcome> = Promise.resolve()
      .then(() => node.run(context))
      .then((value): NodeOutcome => ({ ok: true, id: node.id, value }))
      .catch((error: unknown): NodeOutcome => ({
        ok: false,
        id: node.id,
        error,
      }));
    active.set(node.id, outcome);
  };

  try {
    while (completed.size + (failure === undefined ? 0 : pending.size) < definition.nodes.length) {
      if (controller.signal.aborted && failure === undefined) failure = abortedError();

      if (failure === undefined) {
        for (const node of definition.nodes) {
          if (!pending.has(node.id) || active.size >= concurrency) continue;
          if (!needsFor(node).every((dependency) => completed.has(dependency))) continue;
          const resource = node.resource ?? "default";
          if (resourceCounts[resource] >= limits[resource]) continue;
          launch(node);
        }
      }

      if (active.size === 0) {
        if (failure !== undefined) break;
        throw new Error("Workflow scheduler made no progress after validation.");
      }

      const outcome = await Promise.race(active.values());
      active.delete(outcome.id);
      const resource = activeResource.get(outcome.id);
      if (resource !== undefined) resourceCounts[resource] -= 1;
      activeResource.delete(outcome.id);
      if (outcome.ok && failure === undefined) {
        try {
          const resultBytes = structuredOutputBytes(outcome.value, outcome.id);
          if (resultBytes > outputLimit - outputBytes) {
            throw new WorkflowRunError(
              "output-limit",
              `Workflow results exceed the ${outputLimit}-byte output limit at node ${JSON.stringify(outcome.id)}.`,
              { node: outcome.id },
            );
          }
          outputBytes += resultBytes;
          values.set(
            outcome.id as WorkflowResultId<Results>,
            outcome.value as WorkflowResultValue<Results>,
          );
          completed.add(outcome.id);
        } catch (error: unknown) {
          controller.abort(error);
          failure = error instanceof WorkflowRunError
            ? error
            : new WorkflowRunError(
                "node-failed",
                `Workflow node ${JSON.stringify(outcome.id)} failed while validating its result.`,
                { node: outcome.id, cause: error },
              );
        }
      } else if (!outcome.ok && failure === undefined) {
        controller.abort(outcome.error);
        failure = abortedByCaller
          ? abortedError()
          : new WorkflowRunError(
              "node-failed",
              `Workflow node ${JSON.stringify(outcome.id)} failed.`,
              { node: outcome.id, cause: outcome.error },
            );
      }
    }

    while (active.size > 0) {
      const outcome = await Promise.race(active.values());
      active.delete(outcome.id);
    }
    if (failure !== undefined) throw failure;
    let finalOutputBytes = 0;
    for (const node of definition.nodes) {
      const resultBytes = structuredOutputBytes(values.get(node.id), node.id);
      if (resultBytes > outputLimit - finalOutputBytes) {
        throw new WorkflowRunError(
          "output-limit",
          `Workflow results exceed the ${outputLimit}-byte output limit at node ${JSON.stringify(node.id)}.`,
          { node: node.id },
        );
      }
      finalOutputBytes += resultBytes;
    }
    const orderedValues = new Map<
      WorkflowResultId<Results>,
      WorkflowResultValue<Results>
    >(
      definition.nodes.map((node) => [node.id, completedValue(node.id)] as const),
    );
    return {
      workflow: definition.id,
      outputNode: definition.output,
      output: values.get(definition.output) as Results[Output],
      outputBytes: finalOutputBytes,
      trace: definition.nodes.map((node): WorkflowNodeTrace => ({
        id: node.id,
        needs: needsFor(node),
        resource: node.resource ?? "default",
        status: "completed",
      })),
      results: orderedValues,
    };
  } finally {
    options.signal?.removeEventListener("abort", abort);
  }
}
