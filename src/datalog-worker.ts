import datascript from "datascript";

import type {
  DatalogWorkerRequest,
  DatalogWorkerResponse,
} from "./datalog.js";

const ABSOLUTE_MAX_RESULT_ROWS = 10_000;
const ABSOLUTE_MAX_RESULT_VALUES = 100_000;
const ABSOLUTE_MAX_SCALAR_BYTES = 64 * 1_024;
const ABSOLUTE_MAX_RESULT_BYTES = 4 * 1_024 * 1_024;

type ResultInspection =
  | "ok"
  | "engine"
  | "result-limit"
  | "result-value-limit"
  | "result-scalar-byte-limit"
  | "result-byte-limit";

type ResultBudget = {
  bytes: number;
  values: number;
};

const utf8Encoder = new TextEncoder();

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validRequest(value: unknown): value is DatalogWorkerRequest {
  if (!isRecord(value)) return false;
  if (typeof value.query !== "string" || !Array.isArray(value.relation)) {
    return false;
  }
  if (!Array.isArray(value.inputs)) return false;
  if (value.rules !== undefined && typeof value.rules !== "string") return false;
  if (
    value.findKind !== "relation"
    && value.findKind !== "tuple"
    && value.findKind !== "collection"
    && value.findKind !== "scalar"
  ) return false;
  return Number.isSafeInteger(value.maxRows)
    && (value.maxRows as number) >= 0
    && (value.maxRows as number) <= ABSOLUTE_MAX_RESULT_ROWS
    && Number.isSafeInteger(value.maxValues)
    && (value.maxValues as number) >= 0
    && (value.maxValues as number) <= ABSOLUTE_MAX_RESULT_VALUES
    && Number.isSafeInteger(value.maxScalarBytes)
    && (value.maxScalarBytes as number) >= 0
    && (value.maxScalarBytes as number) <= ABSOLUTE_MAX_SCALAR_BYTES
    && Number.isSafeInteger(value.maxResultBytes)
    && (value.maxResultBytes as number) >= 0
    && (value.maxResultBytes as number) <= ABSOLUTE_MAX_RESULT_BYTES;
}

function scalarText(value: unknown): string | undefined {
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return String(value);
  if (
    typeof value === "number"
    && Number.isFinite(value)
    && (!Number.isInteger(value) || Number.isSafeInteger(value))
  ) return Object.is(value, -0) ? "-0" : String(value);
  return undefined;
}

function inspectScalar(
  value: unknown,
  request: DatalogWorkerRequest,
  budget: ResultBudget,
): ResultInspection {
  if (budget.values >= request.maxValues) return "result-value-limit";
  const text = scalarText(value);
  if (text === undefined) return "engine";
  if (text.length > request.maxScalarBytes) {
    return "result-scalar-byte-limit";
  }
  const bytes = utf8Encoder.encode(text).byteLength;
  if (bytes > request.maxScalarBytes) return "result-scalar-byte-limit";
  if (bytes > request.maxResultBytes - budget.bytes) {
    return "result-byte-limit";
  }
  budget.values += 1;
  budget.bytes += bytes;
  return "ok";
}

function inspectRow(
  value: unknown,
  request: DatalogWorkerRequest,
  budget: ResultBudget,
): ResultInspection {
  if (!Array.isArray(value)) return "engine";
  if (value.length > request.maxValues - budget.values) {
    return "result-value-limit";
  }
  for (const scalar of value) {
    const inspection = inspectScalar(scalar, request, budget);
    if (inspection !== "ok") return inspection;
  }
  return "ok";
}

function inspectResult(
  result: unknown,
  request: DatalogWorkerRequest,
): ResultInspection {
  const budget: ResultBudget = { bytes: 0, values: 0 };
  if (request.findKind === "scalar" || request.findKind === "tuple") {
    return result === null
      ? "ok"
      : inspectRow(result, request, budget);
  }
  if (!Array.isArray(result)) return "engine";
  if (result.length > request.maxRows) return "result-limit";
  if (request.findKind === "collection") {
    if (result.length > request.maxValues) return "result-value-limit";
    for (const scalar of result) {
      const inspection = inspectScalar(scalar, request, budget);
      if (inspection !== "ok") return inspection;
    }
    return "ok";
  }
  for (const row of result) {
    const inspection = inspectRow(row, request, budget);
    if (inspection !== "ok") return inspection;
  }
  return "ok";
}

function respond(response: DatalogWorkerResponse): void {
  if (typeof process.send !== "function") {
    throw new Error("Datalog subprocess requires an IPC channel.");
  }
  process.send(response);
}

process.once("message", (message: unknown): void => {
  if (!validRequest(message)) {
    respond({ ok: false, kind: "invalid-request" });
    return;
  }
  try {
    const result: unknown = datascript.q(
      message.query,
      message.relation,
      ...(message.rules === undefined ? [] : [message.rules]),
      ...message.inputs,
    );
    const inspection = inspectResult(result, message);
    if (inspection !== "ok") {
      respond({ ok: false, kind: inspection });
      return;
    }
    respond({ ok: true, result });
  } catch {
    respond({ ok: false, kind: "engine" });
  }
});
