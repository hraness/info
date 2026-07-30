// @bun
// src/workflow.ts
import { serialize } from "v8";
var MAX_WORKFLOW_NODES = 64;
var MAX_WORKFLOW_CONCURRENCY = 8;
var MAX_GIT_WORKFLOW_CONCURRENCY = 4;
var DEFAULT_WORKFLOW_OUTPUT_BYTES = 16 * 1024 * 1024;
var MAX_WORKFLOW_OUTPUT_BYTES = 64 * 1024 * 1024;
var workflowIdPattern = /^[a-z][a-z0-9-]{0,63}$/u;

class WorkflowRunError extends Error {
  kind;
  node;
  constructor(kind, message, options = {}) {
    super(message, options);
    this.name = "WorkflowRunError";
    this.kind = kind;
    if (options.node !== undefined)
      this.node = options.node;
  }
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function needsFor(node) {
  return node.needs ?? [];
}
function validateWorkflowId(id, label) {
  if (!workflowIdPattern.test(id)) {
    throw new Error(`${label} must start with a lowercase letter and contain at most 64 lowercase letters, digits, or hyphens.`);
  }
}
function validateWorkflow(definition) {
  validateWorkflowId(definition.id, "Workflow id");
  if (definition.nodes.length < 1 || definition.nodes.length > MAX_WORKFLOW_NODES) {
    throw new RangeError(`A workflow must contain from 1 through ${MAX_WORKFLOW_NODES} nodes.`);
  }
  const nodesById = new Map;
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
      throw new Error(`Workflow node ${JSON.stringify(node.id)} repeats a dependency.`);
    }
    nodesById.set(node.id, node);
  }
  if (!nodesById.has(definition.output)) {
    throw new Error(`Workflow output node ${JSON.stringify(definition.output)} does not exist.`);
  }
  for (const node of definition.nodes) {
    for (const dependency of needsFor(node)) {
      if (!nodesById.has(dependency)) {
        throw new Error(`Workflow node ${JSON.stringify(node.id)} depends on unknown node ${JSON.stringify(dependency)}.`);
      }
      if (dependency === node.id) {
        throw new Error(`Workflow node ${JSON.stringify(node.id)} cannot depend on itself.`);
      }
    }
  }
  const remaining = new Set(nodesById.keys());
  const completed = new Set;
  while (remaining.size > 0) {
    const ready = definition.nodes.filter((node) => remaining.has(node.id) && needsFor(node).every((dependency) => completed.has(dependency)));
    if (ready.length === 0) {
      throw new Error(`Workflow contains a dependency cycle among: ${[...remaining].join(", ")}.`);
    }
    for (const node of ready) {
      remaining.delete(node.id);
      completed.add(node.id);
    }
  }
}
function createWorkflowBuilder(id, nodes) {
  const builder = {
    node: (node) => createWorkflowBuilder(id, [...nodes, node]),
    output: (output) => defineWorkflow({
      id,
      nodes,
      output
    })
  };
  return builder;
}
function defineWorkflow(specification) {
  if (typeof specification === "string") {
    return createWorkflowBuilder(specification, []);
  }
  const definition = {
    kind: "hraness-kb-workflow",
    version: 1,
    ...specification
  };
  validateWorkflow(definition);
  return definition;
}
function workflowFromUnknown(value) {
  if (!isRecord(value))
    throw new Error("Workflow export must be an object.");
  if (value.kind !== "hraness-kb-workflow" || value.version !== 1) {
    throw new Error("Workflow export has an unsupported kind or version.");
  }
  if (typeof value.id !== "string" || typeof value.output !== "string" || !Array.isArray(value.nodes)) {
    throw new Error("Workflow export has malformed id, output, or nodes.");
  }
  const nodes = value.nodes.map((item, index) => {
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
      ...needs === undefined ? {} : { needs },
      ...resource === undefined ? {} : { resource },
      run: (context) => {
        const returned = Reflect.apply(run, undefined, [context]);
        return returned;
      }
    };
  });
  const definition = {
    kind: "hraness-kb-workflow",
    version: 1,
    id: value.id,
    nodes,
    output: value.output
  };
  validateWorkflow(definition);
  return definition;
}
function checkedConcurrency(value) {
  const concurrency = value ?? 4;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > MAX_WORKFLOW_CONCURRENCY) {
    throw new RangeError(`Workflow concurrency must be an integer from 1 through ${MAX_WORKFLOW_CONCURRENCY}.`);
  }
  return concurrency;
}
function resourceLimits(concurrency, configured) {
  const limits = {
    default: concurrency,
    git: Math.min(MAX_GIT_WORKFLOW_CONCURRENCY, concurrency),
    qmd: 1
  };
  for (const resource of ["default", "git", "qmd"]) {
    const value = configured?.[resource];
    if (value === undefined)
      continue;
    if (resource === "qmd" && value !== 1) {
      throw new RangeError("Workflow qmd concurrency is fixed at 1.");
    }
    if (!Number.isSafeInteger(value) || value < 1 || value > MAX_WORKFLOW_CONCURRENCY) {
      throw new RangeError(`Workflow ${resource} concurrency must be an integer from 1 through ${MAX_WORKFLOW_CONCURRENCY}.`);
    }
    limits[resource] = resource === "git" ? Math.min(value, concurrency, MAX_GIT_WORKFLOW_CONCURRENCY) : Math.min(value, concurrency);
  }
  return limits;
}
function checkedOutputBytes(value) {
  const maximum = value ?? DEFAULT_WORKFLOW_OUTPUT_BYTES;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > MAX_WORKFLOW_OUTPUT_BYTES) {
    throw new RangeError(`Workflow output byte limit must be an integer from 1 through ${MAX_WORKFLOW_OUTPUT_BYTES}.`);
  }
  return maximum;
}
function structuredOutputBytes(value, node) {
  try {
    return serialize(value).byteLength;
  } catch (error) {
    throw new WorkflowRunError("node-failed", `Workflow node ${JSON.stringify(node)} returned a result that cannot be structurally serialized.`, { node, cause: error });
  }
}
function abortedError() {
  return new WorkflowRunError("aborted", "Workflow execution was aborted.");
}
async function runWorkflow(definition, options) {
  validateWorkflow(definition);
  const concurrency = checkedConcurrency(options.concurrency);
  const limits = resourceLimits(concurrency, options.resourceConcurrency);
  const outputLimit = checkedOutputBytes(options.maxOutputBytes);
  if (options.signal?.aborted === true)
    throw abortedError();
  const controller = new AbortController;
  let abortedByCaller = false;
  const abort = () => {
    abortedByCaller = true;
    controller.abort(options.signal?.reason);
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  const pending = new Set(definition.nodes.map(({ id }) => id));
  const completed = new Set;
  const values = new Map;
  const active = new Map;
  const activeResource = new Map;
  const resourceCounts = {
    default: 0,
    git: 0,
    qmd: 0
  };
  let failure;
  let outputBytes = 0;
  const completedValue = (id) => {
    if (!values.has(id)) {
      throw new Error(`Workflow result ${JSON.stringify(id)} is unavailable after its dependency completed.`);
    }
    return values.get(id);
  };
  const launch = (node) => {
    const resource = node.resource ?? "default";
    pending.delete(node.id);
    resourceCounts[resource] += 1;
    activeResource.set(node.id, resource);
    const needs = needsFor(node);
    const allowedResults = new Set(needs);
    const dependencyResults = new Map(needs.map((id) => [id, completedValue(id)]));
    const context = {
      input: options.input,
      kb: options.kb,
      signal: controller.signal,
      results: dependencyResults,
      result: (id) => {
        if (!allowedResults.has(id)) {
          throw new Error(`Workflow result ${JSON.stringify(id)} is not a declared dependency of ${JSON.stringify(node.id)}.`);
        }
        return dependencyResults.get(id);
      }
    };
    const outcome = Promise.resolve().then(() => node.run(context)).then((value) => ({ ok: true, id: node.id, value })).catch((error) => ({
      ok: false,
      id: node.id,
      error
    }));
    active.set(node.id, outcome);
  };
  try {
    while (completed.size + (failure === undefined ? 0 : pending.size) < definition.nodes.length) {
      if (controller.signal.aborted && failure === undefined)
        failure = abortedError();
      if (failure === undefined) {
        for (const node of definition.nodes) {
          if (!pending.has(node.id) || active.size >= concurrency)
            continue;
          if (!needsFor(node).every((dependency) => completed.has(dependency)))
            continue;
          const resource2 = node.resource ?? "default";
          if (resourceCounts[resource2] >= limits[resource2])
            continue;
          launch(node);
        }
      }
      if (active.size === 0) {
        if (failure !== undefined)
          break;
        throw new Error("Workflow scheduler made no progress after validation.");
      }
      const outcome = await Promise.race(active.values());
      active.delete(outcome.id);
      const resource = activeResource.get(outcome.id);
      if (resource !== undefined)
        resourceCounts[resource] -= 1;
      activeResource.delete(outcome.id);
      if (outcome.ok && failure === undefined) {
        try {
          const resultBytes = structuredOutputBytes(outcome.value, outcome.id);
          if (resultBytes > outputLimit - outputBytes) {
            throw new WorkflowRunError("output-limit", `Workflow results exceed the ${outputLimit}-byte output limit at node ${JSON.stringify(outcome.id)}.`, { node: outcome.id });
          }
          outputBytes += resultBytes;
          values.set(outcome.id, outcome.value);
          completed.add(outcome.id);
        } catch (error) {
          controller.abort(error);
          failure = error instanceof WorkflowRunError ? error : new WorkflowRunError("node-failed", `Workflow node ${JSON.stringify(outcome.id)} failed while validating its result.`, { node: outcome.id, cause: error });
        }
      } else if (!outcome.ok && failure === undefined) {
        controller.abort(outcome.error);
        failure = abortedByCaller ? abortedError() : new WorkflowRunError("node-failed", `Workflow node ${JSON.stringify(outcome.id)} failed.`, { node: outcome.id, cause: outcome.error });
      }
    }
    while (active.size > 0) {
      const outcome = await Promise.race(active.values());
      active.delete(outcome.id);
    }
    if (failure !== undefined)
      throw failure;
    let finalOutputBytes = 0;
    for (const node of definition.nodes) {
      const resultBytes = structuredOutputBytes(values.get(node.id), node.id);
      if (resultBytes > outputLimit - finalOutputBytes) {
        throw new WorkflowRunError("output-limit", `Workflow results exceed the ${outputLimit}-byte output limit at node ${JSON.stringify(node.id)}.`, { node: node.id });
      }
      finalOutputBytes += resultBytes;
    }
    const orderedValues = new Map(definition.nodes.map((node) => [node.id, completedValue(node.id)]));
    return {
      workflow: definition.id,
      outputNode: definition.output,
      output: values.get(definition.output),
      outputBytes: finalOutputBytes,
      trace: definition.nodes.map((node) => ({
        id: node.id,
        needs: needsFor(node),
        resource: node.resource ?? "default",
        status: "completed"
      })),
      results: orderedValues
    };
  } finally {
    options.signal?.removeEventListener("abort", abort);
  }
}

export { MAX_WORKFLOW_NODES, MAX_WORKFLOW_CONCURRENCY, MAX_GIT_WORKFLOW_CONCURRENCY, DEFAULT_WORKFLOW_OUTPUT_BYTES, MAX_WORKFLOW_OUTPUT_BYTES, WorkflowRunError, defineWorkflow, workflowFromUnknown, runWorkflow };
