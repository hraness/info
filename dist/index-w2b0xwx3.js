// @bun
import {
  FACT_ATTRIBUTES,
  MAX_PROJECTED_FACTS,
  projectVaultFacts
} from "./index-9b89cmna.js";

// src/datalog.ts
import { fork } from "child_process";
var DEFAULT_DATALOG_LIMIT = 100;
var MAX_DATALOG_LIMIT = 1000;
var MAX_DATALOG_FACTS = MAX_PROJECTED_FACTS;
var MAX_DATALOG_QUERY_LENGTH = 65536;
var DEFAULT_DATALOG_TIMEOUT_MS = 2000;
var MAX_DATALOG_TIMEOUT_MS = 5000;
var MAX_DATALOG_INPUT_DEPTH = 32;
var MAX_DATALOG_INPUT_VALUES = 1e5;
var MAX_DATALOG_SCALAR_BYTES = 64 * 1024;
var MAX_DATALOG_SNAPSHOT_BYTES = 16 * 1024 * 1024;
var MAX_DATALOG_INPUT_BYTES = 4 * 1024 * 1024;
var MAX_DATALOG_RESULT_ROWS = 1e4;
var MAX_DATALOG_RESULT_VALUES = 1e5;
var MAX_DATALOG_RESULT_BYTES = 4 * 1024 * 1024;
var NODE_DATALOG_OLD_SPACE_MB = 256;

class DatalogBudgetError extends RangeError {
  kind;
  limit;
  constructor(kind, limit, message) {
    super(message);
    this.name = "DatalogBudgetError";
    this.kind = kind;
    this.limit = limit;
  }
}
function isNoteArray(value) {
  return Array.isArray(value);
}
var knownAttributes = new Set(Object.values(FACT_ATTRIBUTES));
function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
function queryForEngine(source) {
  let result = "";
  let cursor = 0;
  while (cursor < source.length) {
    const character = source[cursor] ?? "";
    if (character === '"') {
      const end2 = skipString(source, cursor);
      result += source.slice(cursor, end2);
      cursor = end2;
      continue;
    }
    if (character === ";") {
      const newline = source.indexOf(`
`, cursor + 1);
      const end2 = newline === -1 ? source.length : newline + 1;
      result += source.slice(cursor, end2);
      cursor = end2;
      continue;
    }
    if (character !== ":") {
      result += character;
      cursor += 1;
      continue;
    }
    let end = cursor + 1;
    while (end < source.length && !/[\s,()[\]{}";]/u.test(source[end] ?? ""))
      end += 1;
    const token = source.slice(cursor, end);
    result += knownAttributes.has(token) ? JSON.stringify(token) : token;
    cursor = end;
  }
  return result;
}
function scalarRank(value) {
  if (value === null)
    return 0;
  if (typeof value === "boolean")
    return 1;
  if (typeof value === "number")
    return 2;
  return 3;
}
function compareScalars(left, right) {
  const rank = scalarRank(left) - scalarRank(right);
  if (rank !== 0)
    return rank;
  if (typeof left === "boolean" && typeof right === "boolean") {
    return Number(left) - Number(right);
  }
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }
  if (typeof left === "string" && typeof right === "string") {
    return compareText(left, right);
  }
  return 0;
}
function compareRows(left, right) {
  const length = Math.min(left.length, right.length);
  for (let index = 0;index < length; index += 1) {
    const compared = compareScalars(left[index] ?? null, right[index] ?? null);
    if (compared !== 0)
      return compared;
  }
  return left.length - right.length;
}
function isDatalogNumber(value) {
  return Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value));
}
function scalarFromUnknown(value, context) {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && isDatalogNumber(value)) {
    return value;
  }
  throw new TypeError(`${context} is not an owned Datalog scalar.`);
}
var utf8Encoder = new TextEncoder;
function scalarText(value) {
  if (value === null)
    return "null";
  if (typeof value === "number" && Object.is(value, -0))
    return "-0";
  return typeof value === "string" ? value : String(value);
}
function consumeScalarBytes(value, context, budget) {
  const text = scalarText(value);
  if (text.length > MAX_DATALOG_SCALAR_BYTES) {
    throw new DatalogBudgetError(budget.kind, MAX_DATALOG_SCALAR_BYTES, `${context} exceeds the ${MAX_DATALOG_SCALAR_BYTES}-byte per-scalar UTF-8 limit.`);
  }
  const bytes = utf8Encoder.encode(text).byteLength;
  if (bytes > MAX_DATALOG_SCALAR_BYTES) {
    throw new DatalogBudgetError(budget.kind, MAX_DATALOG_SCALAR_BYTES, `${context} exceeds the ${MAX_DATALOG_SCALAR_BYTES}-byte per-scalar UTF-8 limit.`);
  }
  if (bytes > budget.limit - budget.used) {
    throw new DatalogBudgetError(budget.kind, budget.limit, `${budget.label} exceeds the ${budget.limit}-byte cumulative UTF-8 limit.`);
  }
  budget.used += bytes;
}
function scalarWithByteBudgetFromUnknown(value, context, budget) {
  const scalar = scalarFromUnknown(value, context);
  consumeScalarBytes(scalar, context, budget);
  return scalar;
}
function dataProperty(value, key, context) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !("value" in descriptor)) {
    throw new TypeError(`${context} must have a data property named ${key}.`);
  }
  return descriptor.value;
}
function arrayValues(value, context, maximum) {
  if (!Array.isArray(value)) {
    throw new TypeError(`${context} must be an array.`);
  }
  const length = dataProperty(value, "length", context);
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new TypeError(`${context} has an invalid length.`);
  }
  if (maximum !== undefined && length > maximum.length) {
    throw maximum.error();
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string" || key !== "length" && !/^(?:0|[1-9]\d*)$/u.test(key))) {
    throw new TypeError(`${context} must be a dense data-only array.`);
  }
  const result = [];
  for (let index = 0;index < length; index += 1) {
    result.push(dataProperty(value, String(index), context));
  }
  return result;
}
function snapshotFactLimitError() {
  return new DatalogBudgetError("fact-limit", MAX_DATALOG_FACTS, `Datalog snapshot exceeds the ${MAX_DATALOG_FACTS} fact limit.`);
}
function inputValueLimitError() {
  return new RangeError(`Datalog inputs exceed the ${MAX_DATALOG_INPUT_VALUES} value limit.`);
}
function resultRowLimitError() {
  return new DatalogBudgetError("result-limit", MAX_DATALOG_RESULT_ROWS, `Datalog query returned more than the ${MAX_DATALOG_RESULT_ROWS}-row safety threshold.`);
}
function resultValueLimitError() {
  return new DatalogBudgetError("result-value-limit", MAX_DATALOG_RESULT_VALUES, `Datalog query returned more than the ${MAX_DATALOG_RESULT_VALUES}-value safety threshold.`);
}
function resultByteLimitError() {
  return new DatalogBudgetError("result-byte-limit", MAX_DATALOG_RESULT_BYTES, `Datalog query result exceeds the ${MAX_DATALOG_RESULT_BYTES}-byte cumulative UTF-8 limit.`);
}
function resultScalarByteLimitError() {
  return new DatalogBudgetError("result-byte-limit", MAX_DATALOG_SCALAR_BYTES, `Datalog query result contains a scalar above the ${MAX_DATALOG_SCALAR_BYTES}-byte UTF-8 limit.`);
}
function factFromUnknown(value, index, budget) {
  const context = `Datalog snapshot fact ${index}`;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${context} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${context} must be a plain object.`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 4 || keys.some((key) => typeof key !== "string" || !["kind", "entity", "attribute", "value"].includes(key))) {
    throw new TypeError(`${context} has an invalid shape.`);
  }
  const kind = dataProperty(value, "kind", context);
  const entity = dataProperty(value, "entity", context);
  const attribute = dataProperty(value, "attribute", context);
  const factValue = dataProperty(value, "value", context);
  if (kind !== "scalar" && kind !== "reference") {
    throw new TypeError(`${context} has an invalid kind.`);
  }
  if (typeof entity !== "string" || entity === "") {
    throw new TypeError(`${context} has an invalid semantic entity ID.`);
  }
  if (typeof attribute !== "string" || !knownAttributes.has(attribute)) {
    throw new TypeError(`${context} has an unknown attribute.`);
  }
  consumeScalarBytes(entity, `${context} entity`, budget);
  consumeScalarBytes(attribute, `${context} attribute`, budget);
  if (kind === "reference") {
    if (typeof factValue !== "string" || factValue === "") {
      throw new TypeError(`${context} has an invalid semantic reference ID.`);
    }
    consumeScalarBytes(factValue, `${context} value`, budget);
    return {
      kind,
      entity,
      attribute,
      value: factValue
    };
  }
  return {
    kind,
    entity,
    attribute,
    value: scalarWithByteBudgetFromUnknown(factValue, `${context} value`, budget)
  };
}
function consumeOwnedFactBytes(fact, index, budget) {
  const context = `Datalog projected fact ${index}`;
  consumeScalarBytes(fact.entity, `${context} entity`, budget);
  consumeScalarBytes(fact.attribute, `${context} attribute`, budget);
  consumeScalarBytes(fact.value, `${context} value`, budget);
}
function parsedSnapshot(snapshot) {
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new TypeError("Datalog snapshot must be an object.");
  }
  const version = dataProperty(snapshot, "version", "Datalog snapshot");
  const factCount = dataProperty(snapshot, "factCount", "Datalog snapshot");
  if (version !== 1)
    throw new TypeError("Unsupported Datalog snapshot version.");
  if (!Number.isSafeInteger(factCount) || factCount < 0) {
    throw new TypeError("Datalog snapshot has an invalid fact count.");
  }
  if (factCount > MAX_DATALOG_FACTS) {
    throw snapshotFactLimitError();
  }
  const factsValue = dataProperty(snapshot, "facts", "Datalog snapshot");
  const values = arrayValues(factsValue, "Datalog snapshot facts", {
    length: MAX_DATALOG_FACTS,
    error: snapshotFactLimitError
  });
  if (values.length !== factCount) {
    throw new TypeError("Datalog snapshot fact count does not match its facts.");
  }
  const byteBudget = {
    kind: "snapshot-byte-limit",
    label: "Datalog snapshot",
    limit: MAX_DATALOG_SNAPSHOT_BYTES,
    used: 0
  };
  const facts = values.map((value, index) => factFromUnknown(value, index, byteBudget));
  return {
    version: 1,
    facts,
    factCount: facts.length
  };
}
function buildDatalogSnapshot(notesOrOptions, possibleAnalysis) {
  const notes = isNoteArray(notesOrOptions) ? notesOrOptions : notesOrOptions.notes;
  const analysis = isNoteArray(notesOrOptions) ? possibleAnalysis : notesOrOptions.analysis;
  if (analysis === undefined) {
    throw new TypeError("Building a Datalog snapshot requires a vault analysis.");
  }
  const projected = projectVaultFacts(notes, analysis, {
    maxFacts: MAX_DATALOG_FACTS
  });
  const byteBudget = {
    kind: "snapshot-byte-limit",
    label: "Datalog snapshot",
    limit: MAX_DATALOG_SNAPSHOT_BYTES,
    used: 0
  };
  projected.forEach((fact, index) => {
    consumeOwnedFactBytes(fact, index, byteBudget);
  });
  const facts = Object.freeze(projected.map((fact) => Object.freeze({ ...fact })));
  return Object.freeze({
    version: 1,
    facts,
    factCount: facts.length
  });
}
function parseInput(value, depth, budget) {
  budget.count += 1;
  if (budget.count > MAX_DATALOG_INPUT_VALUES) {
    throw inputValueLimitError();
  }
  if (depth > MAX_DATALOG_INPUT_DEPTH) {
    throw new RangeError(`Datalog inputs exceed the ${MAX_DATALOG_INPUT_DEPTH} level depth limit.`);
  }
  if (Array.isArray(value)) {
    return arrayValues(value, "Datalog input", {
      length: MAX_DATALOG_INPUT_VALUES - budget.count,
      error: inputValueLimitError
    }).map((candidate) => parseInput(candidate, depth + 1, budget));
  }
  return scalarWithByteBudgetFromUnknown(value, "Datalog input", budget.bytes);
}
function parsedInputs(inputs) {
  if (inputs === undefined)
    return [];
  const budget = {
    count: 0,
    bytes: {
      kind: "input-byte-limit",
      label: "Datalog inputs",
      limit: MAX_DATALOG_INPUT_BYTES,
      used: 0
    }
  };
  return arrayValues(inputs, "Datalog inputs", {
    length: MAX_DATALOG_INPUT_VALUES,
    error: inputValueLimitError
  }).map((value) => parseInput(value, 0, budget));
}
var matchingDelimiter = {
  "(": ")",
  "[": "]",
  "{": "}"
};
function skipString(source, start) {
  for (let index = start + 1;index < source.length; index += 1) {
    if (source[index] === "\\") {
      index += 1;
      continue;
    }
    if (source[index] === '"')
      return index + 1;
  }
  throw new TypeError("Datalog query contains an unterminated string.");
}
function collectionEnd(source, start) {
  const first = source[start] ?? "";
  const firstClose = matchingDelimiter[first];
  if (firstClose === undefined) {
    throw new TypeError("Datalog query collection has an invalid delimiter.");
  }
  const stack = [firstClose];
  for (let index = start + 1;index < source.length; index += 1) {
    const character = source[index] ?? "";
    if (character === '"') {
      index = skipString(source, index) - 1;
      continue;
    }
    if (character === ";") {
      const newline = source.indexOf(`
`, index + 1);
      if (newline === -1)
        break;
      index = newline;
      continue;
    }
    const close = matchingDelimiter[character];
    if (close !== undefined) {
      stack.push(close);
      continue;
    }
    if (character === ")" || character === "]" || character === "}") {
      if (stack.at(-1) !== character) {
        throw new TypeError("Datalog query contains mismatched delimiters.");
      }
      stack.pop();
      if (stack.length === 0)
        return index + 1;
    }
  }
  throw new TypeError("Datalog query contains an unterminated collection.");
}
function ignoredEnd(source, start, limit) {
  let index = start;
  while (index < limit) {
    const character = source[index] ?? "";
    if (/\s/u.test(character) || character === ",") {
      index += 1;
      continue;
    }
    if (character === ";") {
      const newline = source.indexOf(`
`, index + 1);
      index = newline === -1 || newline >= limit ? limit : newline + 1;
      continue;
    }
    break;
  }
  return index;
}
function tokensInside(source, start, end) {
  const tokens = [];
  let index = ignoredEnd(source, start, end);
  while (index < end) {
    const tokenStart = index;
    const character = source[index] ?? "";
    if (matchingDelimiter[character] !== undefined) {
      index = collectionEnd(source, index);
      if (index > end) {
        throw new TypeError("Datalog query token escapes its containing collection.");
      }
    } else if (character === '"') {
      index = skipString(source, index);
    } else {
      while (index < end) {
        const candidate = source[index] ?? "";
        if (/\s/u.test(candidate) || candidate === "," || candidate === ";" || candidate === ")" || candidate === "]" || candidate === "}")
          break;
        index += 1;
      }
      if (index === tokenStart) {
        throw new TypeError("Datalog query contains an unexpected delimiter.");
      }
    }
    tokens.push({
      text: source.slice(tokenStart, index),
      start: tokenStart,
      end: index
    });
    index = ignoredEnd(source, index, end);
  }
  return tokens;
}
function findShape(query) {
  if (query.length === 0 || query.length > MAX_DATALOG_QUERY_LENGTH) {
    throw new RangeError(`Datalog query length must be between 1 and ${MAX_DATALOG_QUERY_LENGTH} characters.`);
  }
  const start = ignoredEnd(query, 0, query.length);
  if (query[start] !== "[") {
    throw new TypeError("Datalog query must be an EDN vector.");
  }
  const end = collectionEnd(query, start);
  if (ignoredEnd(query, end, query.length) !== query.length) {
    throw new TypeError("Datalog query has trailing content.");
  }
  const tokens = tokensInside(query, start + 1, end - 1);
  const findIndex = tokens.findIndex((token) => token.text === ":find");
  if (findIndex === -1) {
    throw new TypeError("Datalog query must contain a :find clause.");
  }
  if (tokens.findIndex((token, index) => index > findIndex && token.text === ":find") !== -1) {
    throw new TypeError("Datalog query contains duplicate :find clauses.");
  }
  if (tokens.some((token) => token.text === ":keys" || token.text === ":strs" || token.text === ":syms")) {
    throw new TypeError("Datalog map return specifications are not supported.");
  }
  const sectionNames = new Set([":with", ":in", ":where"]);
  const sectionIndex = tokens.findIndex((token, index) => index > findIndex && sectionNames.has(token.text));
  const findTermTokens = tokens.slice(findIndex + 1, sectionIndex === -1 ? tokens.length : sectionIndex);
  const findTerms = findTermTokens.map((token) => token.text);
  if (findTerms.length === 0) {
    throw new TypeError("Datalog :find clause must contain at least one term.");
  }
  if (findTerms.at(-1) === ".") {
    if (findTerms.length !== 2) {
      throw new TypeError("Datalog scalar find must contain exactly one term.");
    }
    const term = findTermTokens[0];
    const scalarMarker = findTermTokens[1];
    if (term === undefined || scalarMarker === undefined) {
      throw new TypeError("Datalog scalar find is malformed.");
    }
    return {
      columns: [term.text],
      engineQuery: [
        query.slice(0, term.start),
        `[${term.text}]`,
        query.slice(scalarMarker.end)
      ].join(""),
      kind: "scalar"
    };
  }
  const onlyTerm = findTerms.length === 1 ? findTerms[0] : undefined;
  if (onlyTerm?.startsWith("[") === true) {
    const collectionEndIndex = collectionEnd(onlyTerm, 0);
    if (collectionEndIndex !== onlyTerm.length) {
      throw new TypeError("Datalog find specification is malformed.");
    }
    const inner = tokensInside(onlyTerm, 1, onlyTerm.length - 1).map((token) => token.text);
    if (inner.at(-1) === "...") {
      if (inner.length !== 2) {
        throw new TypeError("Datalog collection find must contain exactly one term.");
      }
      return {
        columns: [inner[0] ?? ""],
        engineQuery: query,
        kind: "collection"
      };
    }
    if (inner.length === 0) {
      throw new TypeError("Datalog tuple find must not be empty.");
    }
    return { columns: inner, engineQuery: query, kind: "tuple" };
  }
  return { columns: findTerms, engineQuery: query, kind: "relation" };
}
function parsedRow(value, columns, context, budget) {
  const values = arrayValues(value, context);
  if (values.length !== columns.length) {
    throw new TypeError(`${context} has ${values.length} values for ${columns.length} columns.`);
  }
  return values.map((candidate, index) => {
    budget.values += 1;
    if (budget.values > MAX_DATALOG_RESULT_VALUES) {
      throw resultValueLimitError();
    }
    return scalarWithByteBudgetFromUnknown(candidate, `${context} column ${columns[index] ?? index}`, budget.bytes);
  });
}
function resultRows(result, shape) {
  const budget = {
    bytes: {
      kind: "result-byte-limit",
      label: "Datalog query result",
      limit: MAX_DATALOG_RESULT_BYTES,
      used: 0
    },
    values: 0
  };
  if (shape.kind === "scalar") {
    return result === null ? [] : [parsedRow(result, shape.columns, "Datalog scalar result envelope", budget)];
  }
  if (shape.kind === "tuple") {
    if (shape.columns.length > MAX_DATALOG_RESULT_VALUES) {
      throw resultValueLimitError();
    }
    return result === null ? [] : [parsedRow(result, shape.columns, "Datalog tuple result", budget)];
  }
  const values = arrayValues(result, "Datalog query result", {
    length: MAX_DATALOG_RESULT_ROWS,
    error: resultRowLimitError
  });
  if (shape.kind === "collection") {
    if (values.length > MAX_DATALOG_RESULT_VALUES) {
      throw resultValueLimitError();
    }
    return values.map((value) => {
      budget.values += 1;
      return [scalarWithByteBudgetFromUnknown(value, "Datalog collection result", budget.bytes)];
    });
  }
  if (shape.columns.length > 0 && values.length > Math.floor(MAX_DATALOG_RESULT_VALUES / shape.columns.length)) {
    throw resultValueLimitError();
  }
  return values.map((value, index) => parsedRow(value, shape.columns, `Datalog result row ${index}`, budget));
}
function checkedLimit(limit) {
  const result = limit ?? DEFAULT_DATALOG_LIMIT;
  if (!Number.isSafeInteger(result) || result < 0 || result > MAX_DATALOG_LIMIT) {
    throw new RangeError(`Datalog limit must be a safe integer from 0 to ${MAX_DATALOG_LIMIT}.`);
  }
  return result;
}
function checkedTimeout(timeoutMs) {
  const result = timeoutMs ?? DEFAULT_DATALOG_TIMEOUT_MS;
  if (!Number.isSafeInteger(result) || result < 1 || result > MAX_DATALOG_TIMEOUT_MS) {
    throw new RangeError(`Datalog timeout must be a safe integer from 1 to ${MAX_DATALOG_TIMEOUT_MS} milliseconds.`);
  }
  return result;
}
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function datalogWorkerUrl(moduleUrl = import.meta.url) {
  return moduleUrl.endsWith(".ts") ? new URL("./datalog-worker.ts", moduleUrl) : new URL("./datalog-worker.js", moduleUrl);
}
function datalogChildExecArgv() {
  return process.versions.bun === undefined ? [`--max-old-space-size=${NODE_DATALOG_OLD_SPACE_MB}`] : ["--smol"];
}
function stopDatalogChild(child) {
  if (child === undefined)
    return;
  if (child.connected)
    child.disconnect();
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
}
async function runDatalogSubprocess(request, timeoutMs) {
  let child;
  let timeout;
  try {
    child = fork(datalogWorkerUrl(), [], {
      execArgv: datalogChildExecArgv(),
      serialization: "advanced",
      stdio: ["ignore", "ignore", "ignore", "ipc"]
    });
    const runningChild = child;
    const response = await new Promise((resolve, reject) => {
      timeout = setTimeout(() => {
        reject(new DatalogBudgetError("timeout", timeoutMs, `Datalog query exceeded the ${timeoutMs}ms subprocess execution deadline.`));
      }, timeoutMs);
      runningChild.once("message", (message) => {
        if (!isRecord(message) || typeof message.ok !== "boolean") {
          reject(new Error("Datalog subprocess returned malformed data."));
          return;
        }
        if (message.ok === true && Object.hasOwn(message, "result")) {
          resolve({ ok: true, result: message.result });
          return;
        }
        const kind = message.kind;
        if (kind !== "engine" && kind !== "invalid-request" && kind !== "result-limit" && kind !== "result-value-limit" && kind !== "result-scalar-byte-limit" && kind !== "result-byte-limit") {
          reject(new Error("Datalog subprocess returned malformed data."));
          return;
        }
        resolve({ ok: false, kind });
      });
      runningChild.once("error", () => {
        reject(new Error("Datalog subprocess failed."));
      });
      runningChild.once("exit", (code, signal) => {
        reject(new Error(`Datalog subprocess exited before returning a result (${signal ?? code ?? "unknown"}).`));
      });
      runningChild.send(request, (error) => {
        if (error !== null) {
          reject(new Error("Datalog subprocess request failed."));
        }
      });
    });
    if (response.ok)
      return response.result;
    if (response.kind === "result-limit") {
      throw resultRowLimitError();
    }
    if (response.kind === "result-value-limit") {
      throw resultValueLimitError();
    }
    if (response.kind === "result-scalar-byte-limit") {
      throw resultScalarByteLimitError();
    }
    if (response.kind === "result-byte-limit") {
      throw resultByteLimitError();
    }
    if (response.kind === "invalid-request") {
      throw new Error("Datalog subprocess rejected its bounded request.");
    }
    throw new Error("DataScript rejected the Datalog query.");
  } finally {
    if (timeout !== undefined)
      clearTimeout(timeout);
    stopDatalogChild(child);
  }
}
function statementFromOptions(optionsOrSnapshot, possibleStatement) {
  return possibleStatement ?? optionsOrSnapshot;
}
function snapshotFromOptions(optionsOrSnapshot, possibleStatement) {
  if (possibleStatement !== undefined) {
    return parsedSnapshot(optionsOrSnapshot);
  }
  const options = optionsOrSnapshot;
  if ("snapshot" in options && options.snapshot !== undefined) {
    return parsedSnapshot(options.snapshot);
  }
  return buildDatalogSnapshot(options.notes, options.analysis);
}
async function queryDatalog(optionsOrSnapshot, possibleStatement) {
  const statement = statementFromOptions(optionsOrSnapshot, possibleStatement);
  const shape = findShape(statement.query);
  const limit = checkedLimit(statement.limit);
  const timeoutMs = checkedTimeout(statement.timeoutMs);
  const inputs = parsedInputs(statement.inputs);
  const rules = statement.rules;
  if (rules !== undefined && (typeof rules !== "string" || rules.length === 0 || rules.length > MAX_DATALOG_QUERY_LENGTH)) {
    throw new RangeError(`Datalog rules length must be between 1 and ${MAX_DATALOG_QUERY_LENGTH} characters.`);
  }
  const snapshot = snapshotFromOptions(optionsOrSnapshot, possibleStatement);
  const relation = snapshot.facts.map((fact) => [fact.entity, fact.attribute, fact.value]);
  const foreignResult = await runDatalogSubprocess({
    query: queryForEngine(shape.engineQuery),
    relation,
    ...rules === undefined ? {} : { rules: queryForEngine(rules) },
    inputs,
    findKind: shape.kind,
    maxRows: MAX_DATALOG_RESULT_ROWS,
    maxValues: MAX_DATALOG_RESULT_VALUES,
    maxScalarBytes: MAX_DATALOG_SCALAR_BYTES,
    maxResultBytes: MAX_DATALOG_RESULT_BYTES
  }, timeoutMs);
  const rows = resultRows(foreignResult, shape).toSorted(compareRows);
  return {
    columns: shape.columns,
    rows: rows.slice(0, limit),
    truncated: rows.length > limit,
    factCount: snapshot.factCount
  };
}

export { DEFAULT_DATALOG_LIMIT, MAX_DATALOG_LIMIT, MAX_DATALOG_FACTS, MAX_DATALOG_QUERY_LENGTH, DEFAULT_DATALOG_TIMEOUT_MS, MAX_DATALOG_TIMEOUT_MS, MAX_DATALOG_INPUT_VALUES, MAX_DATALOG_SCALAR_BYTES, MAX_DATALOG_SNAPSHOT_BYTES, MAX_DATALOG_INPUT_BYTES, MAX_DATALOG_RESULT_ROWS, MAX_DATALOG_RESULT_VALUES, MAX_DATALOG_RESULT_BYTES, DatalogBudgetError, buildDatalogSnapshot, datalogWorkerUrl, queryDatalog };
