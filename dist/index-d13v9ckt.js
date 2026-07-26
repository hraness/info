// @bun
// src/navigation.ts
var MAX_NAVIGATION_INDEXED_CONNECTIONS = 1e5;
var MAX_NAVIGATION_RETURNED_CONNECTIONS = 1e4;

class NavigationBudgetError extends RangeError {
  kind;
  limit;
  constructor(kind, limit, message) {
    super(message);
    this.name = "NavigationBudgetError";
    this.kind = kind;
    this.limit = limit;
  }
}
function checkedDepth(value) {
  const depth = value ?? 1;
  if (!Number.isSafeInteger(depth) || depth < 1 || depth > 10) {
    throw new RangeError("Link depth must be an integer from 1 through 10.");
  }
  return depth;
}
function checkedLimit(value) {
  const limit = value ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    throw new RangeError("Link result limit must be an integer from 1 through 1000.");
  }
  return limit;
}
function connectionNode(note, connection, distance) {
  return {
    id: note.id,
    path: note.path,
    title: note.title,
    distance,
    inboundContextualCount: connection?.inboundContextualCount ?? 0,
    outboundContextualCount: connection?.outboundContextualCount ?? 0,
    inboundRelationCount: connection?.inboundRelationCount ?? 0,
    outboundRelationCount: connection?.outboundRelationCount ?? 0
  };
}
function edgeKey(edge) {
  return `${edge.source}\x00${edge.target}\x00${edge.line}`;
}
function relationKey(relation) {
  return `${relation.source}\x00${relation.predicate}\x00${relation.target}`;
}
function compareTraversalCandidates(left, right) {
  return left.source.localeCompare(right.source) || left.target.localeCompare(right.target) || left.kind.localeCompare(right.kind) || (left.kind === "relation" && right.kind === "relation" ? left.relation.predicate.localeCompare(right.relation.predicate) : 0) || left.line - right.line;
}
function addCandidate(candidates, path, candidate) {
  const existing = candidates.get(path) ?? [];
  existing.push(candidate);
  candidates.set(path, existing);
}
function candidateKey(candidate) {
  return candidate.kind === "link" ? `link\x00${edgeKey(candidate.edge)}` : `relation\x00${relationKey(candidate.relation)}`;
}
function checkedConnections(analysis) {
  const authoredRelations = analysis.authoredRelations ?? [];
  const connectionCount = analysis.contextualLinks.length + authoredRelations.length;
  if (connectionCount > MAX_NAVIGATION_INDEXED_CONNECTIONS) {
    throw new NavigationBudgetError("connection-work-limit", MAX_NAVIGATION_INDEXED_CONNECTIONS, `Link navigation exceeds the ${MAX_NAVIGATION_INDEXED_CONNECTIONS} ` + "contextual-link and authored-relation observation limit.");
  }
  return authoredRelations;
}
function returnedConnectionLimit(nodeLimit) {
  return Math.min(MAX_NAVIGATION_RETURNED_CONNECTIONS, nodeLimit ** 2);
}
function navigateLinks(notes, analysis, start, options = {}) {
  const direction = options.direction ?? "both";
  const depth = checkedDepth(options.depth);
  const limit = checkedLimit(options.limit);
  const authoredRelations = checkedConnections(analysis);
  const notesByPath = new Map(notes.map((note) => [note.path, note]));
  const notesById = new Map(notes.map((note) => [note.id, note]));
  const connectionsById = new Map(analysis.noteConnections.map((connection) => [connection.id, connection]));
  const inbound = new Map;
  const outbound = new Map;
  for (const edge of analysis.contextualLinks) {
    const candidate = {
      kind: "link",
      source: edge.source,
      target: edge.target,
      line: edge.line,
      edge
    };
    addCandidate(inbound, edge.target, candidate);
    addCandidate(outbound, edge.source, candidate);
  }
  for (const relation of authoredRelations) {
    const source = notesById.get(relation.source)?.path;
    const target = notesById.get(relation.target)?.path;
    if (source === undefined || target === undefined)
      continue;
    const candidate = {
      kind: "relation",
      source,
      target,
      line: relation.provenance.line,
      relation
    };
    addCandidate(inbound, target, candidate);
    addCandidate(outbound, source, candidate);
  }
  const distanceByPath = new Map([[start.path, 0]]);
  let frontier = [start.path];
  let truncated = false;
  const selectedCandidates = new Map;
  for (let distance = 0;distance < depth && frontier.length > 0; distance += 1) {
    const next = new Set;
    for (const path of frontier.toSorted()) {
      const candidates = [
        ...direction === "out" || direction === "both" ? outbound.get(path) ?? [] : [],
        ...direction === "in" || direction === "both" ? inbound.get(path) ?? [] : []
      ].toSorted(compareTraversalCandidates);
      for (const candidate of candidates) {
        const neighborPath = candidate.source === path ? candidate.target : candidate.source;
        if (!notesByPath.has(neighborPath))
          continue;
        if (distanceByPath.has(neighborPath)) {
          selectedCandidates.set(candidateKey(candidate), candidate);
          continue;
        }
        if (distanceByPath.size >= limit) {
          truncated = true;
          continue;
        }
        selectedCandidates.set(candidateKey(candidate), candidate);
        distanceByPath.set(neighborPath, distance + 1);
        next.add(neighborPath);
      }
    }
    frontier = [...next];
  }
  const nodes = [...distanceByPath].map(([path, distance]) => {
    const note = notesByPath.get(path);
    return note === undefined ? null : connectionNode(note, connectionsById.get(note.id), distance);
  }).filter((node) => node !== null).toSorted((left, right) => left.distance - right.distance || left.path.localeCompare(right.path));
  const sortedCandidates = [...selectedCandidates.values()].toSorted(compareTraversalCandidates);
  const connectionLimit = returnedConnectionLimit(limit);
  if (sortedCandidates.length > connectionLimit)
    truncated = true;
  const returnedCandidates = sortedCandidates.slice(0, connectionLimit);
  const edges = returnedCandidates.filter((candidate) => candidate.kind === "link").map(({ edge }) => edge).toSorted((left, right) => left.source.localeCompare(right.source) || left.target.localeCompare(right.target) || left.line - right.line);
  const relations = returnedCandidates.filter((candidate) => candidate.kind === "relation").map(({ relation }) => relation).toSorted((left, right) => left.source.localeCompare(right.source) || left.predicate.localeCompare(right.predicate) || left.target.localeCompare(right.target) || left.provenance.line - right.provenance.line);
  return { note: start.path, direction, depth, limit, truncated, nodes, edges, relations };
}

export { MAX_NAVIGATION_INDEXED_CONNECTIONS, MAX_NAVIGATION_RETURNED_CONNECTIONS, NavigationBudgetError, navigateLinks };
