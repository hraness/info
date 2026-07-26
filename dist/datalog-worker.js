// @bun
// src/datalog-worker.ts
import datascript from "datascript";
var ABSOLUTE_MAX_RESULT_ROWS = 1e4;
var ABSOLUTE_MAX_RESULT_VALUES = 1e5;
var ABSOLUTE_MAX_SCALAR_BYTES = 64 * 1024;
var ABSOLUTE_MAX_RESULT_BYTES = 4 * 1024 * 1024;
var utf8Encoder = new TextEncoder;
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function validRequest(value) {
  if (!isRecord(value))
    return false;
  if (typeof value.query !== "string" || !Array.isArray(value.relation)) {
    return false;
  }
  if (!Array.isArray(value.inputs))
    return false;
  if (value.rules !== undefined && typeof value.rules !== "string")
    return false;
  if (value.findKind !== "relation" && value.findKind !== "tuple" && value.findKind !== "collection" && value.findKind !== "scalar")
    return false;
  return Number.isSafeInteger(value.maxRows) && value.maxRows >= 0 && value.maxRows <= ABSOLUTE_MAX_RESULT_ROWS && Number.isSafeInteger(value.maxValues) && value.maxValues >= 0 && value.maxValues <= ABSOLUTE_MAX_RESULT_VALUES && Number.isSafeInteger(value.maxScalarBytes) && value.maxScalarBytes >= 0 && value.maxScalarBytes <= ABSOLUTE_MAX_SCALAR_BYTES && Number.isSafeInteger(value.maxResultBytes) && value.maxResultBytes >= 0 && value.maxResultBytes <= ABSOLUTE_MAX_RESULT_BYTES;
}
function scalarText(value) {
  if (value === null)
    return "null";
  if (typeof value === "string")
    return value;
  if (typeof value === "boolean")
    return String(value);
  if (typeof value === "number" && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value)))
    return Object.is(value, -0) ? "-0" : String(value);
  return;
}
function inspectScalar(value, request, budget) {
  if (budget.values >= request.maxValues)
    return "result-value-limit";
  const text = scalarText(value);
  if (text === undefined)
    return "engine";
  if (text.length > request.maxScalarBytes) {
    return "result-scalar-byte-limit";
  }
  const bytes = utf8Encoder.encode(text).byteLength;
  if (bytes > request.maxScalarBytes)
    return "result-scalar-byte-limit";
  if (bytes > request.maxResultBytes - budget.bytes) {
    return "result-byte-limit";
  }
  budget.values += 1;
  budget.bytes += bytes;
  return "ok";
}
function inspectRow(value, request, budget) {
  if (!Array.isArray(value))
    return "engine";
  if (value.length > request.maxValues - budget.values) {
    return "result-value-limit";
  }
  for (const scalar of value) {
    const inspection = inspectScalar(scalar, request, budget);
    if (inspection !== "ok")
      return inspection;
  }
  return "ok";
}
function inspectResult(result, request) {
  const budget = { bytes: 0, values: 0 };
  if (request.findKind === "scalar" || request.findKind === "tuple") {
    return result === null ? "ok" : inspectRow(result, request, budget);
  }
  if (!Array.isArray(result))
    return "engine";
  if (result.length > request.maxRows)
    return "result-limit";
  if (request.findKind === "collection") {
    if (result.length > request.maxValues)
      return "result-value-limit";
    for (const scalar of result) {
      const inspection = inspectScalar(scalar, request, budget);
      if (inspection !== "ok")
        return inspection;
    }
    return "ok";
  }
  for (const row of result) {
    const inspection = inspectRow(row, request, budget);
    if (inspection !== "ok")
      return inspection;
  }
  return "ok";
}
function respond(response) {
  if (typeof process.send !== "function") {
    throw new Error("Datalog subprocess requires an IPC channel.");
  }
  process.send(response);
}
process.once("message", (message) => {
  if (!validRequest(message)) {
    respond({ ok: false, kind: "invalid-request" });
    return;
  }
  try {
    const result = datascript.q(message.query, message.relation, ...message.rules === undefined ? [] : [message.rules], ...message.inputs);
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
