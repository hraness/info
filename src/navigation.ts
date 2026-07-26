import {
  type AuthoredRelation,
  type Note,
  type NoteConnections,
  type ResolvedLink,
  type VaultAnalysis,
} from "./graph.js";

export type LinkDirection = "in" | "out" | "both";

export type NavigateLinksOptions = {
  readonly direction?: LinkDirection;
  readonly depth?: number;
  /** Maximum returned nodes, including the starting note. */
  readonly limit?: number;
};

/**
 * Bound raw contextual links and authored relations before building the two
 * directional indexes. Each accepted connection contributes at most one
 * inbound and one outbound index entry.
 */
export const MAX_NAVIGATION_INDEXED_CONNECTIONS = 100_000;

/** Bound returned contextual links and authored relations as one result set. */
export const MAX_NAVIGATION_RETURNED_CONNECTIONS = 10_000;

export type NavigationBudgetKind = "connection-work-limit";

export class NavigationBudgetError extends RangeError {
  readonly kind: NavigationBudgetKind;
  readonly limit: number;

  constructor(kind: NavigationBudgetKind, limit: number, message: string) {
    super(message);
    this.name = "NavigationBudgetError";
    this.kind = kind;
    this.limit = limit;
  }
}

export type LinkNeighborhoodNode = {
  readonly id: string;
  readonly path: string;
  readonly title: string;
  readonly distance: number;
  readonly inboundContextualCount: number;
  readonly outboundContextualCount: number;
  readonly inboundRelationCount: number;
  readonly outboundRelationCount: number;
};

export type LinkNeighborhood = {
  readonly note: string;
  readonly direction: LinkDirection;
  readonly depth: number;
  readonly limit: number;
  readonly truncated: boolean;
  readonly nodes: readonly LinkNeighborhoodNode[];
  readonly edges: readonly ResolvedLink[];
  readonly relations: readonly AuthoredRelation[];
};

function checkedDepth(value: number | undefined): number {
  const depth = value ?? 1;
  if (!Number.isSafeInteger(depth) || depth < 1 || depth > 10) {
    throw new RangeError("Link depth must be an integer from 1 through 10.");
  }
  return depth;
}

function checkedLimit(value: number | undefined): number {
  const limit = value ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new RangeError("Link result limit must be an integer from 1 through 1000.");
  }
  return limit;
}

function connectionNode(
  note: Note,
  connection: NoteConnections | undefined,
  distance: number,
): LinkNeighborhoodNode {
  return {
    id: note.id,
    path: note.path,
    title: note.title,
    distance,
    inboundContextualCount: connection?.inboundContextualCount ?? 0,
    outboundContextualCount: connection?.outboundContextualCount ?? 0,
    inboundRelationCount: connection?.inboundRelationCount ?? 0,
    outboundRelationCount: connection?.outboundRelationCount ?? 0,
  };
}

function edgeKey(edge: ResolvedLink): string {
  return `${edge.source}\0${edge.target}\0${edge.line}`;
}

function relationKey(relation: AuthoredRelation): string {
  return `${relation.source}\0${relation.predicate}\0${relation.target}`;
}

type TraversalCandidate =
  | {
      readonly kind: "link";
      readonly source: string;
      readonly target: string;
      readonly line: number;
      readonly edge: ResolvedLink;
    }
  | {
      readonly kind: "relation";
      readonly source: string;
      readonly target: string;
      readonly line: number;
      readonly relation: AuthoredRelation;
    };

function compareTraversalCandidates(
  left: TraversalCandidate,
  right: TraversalCandidate,
): number {
  return left.source.localeCompare(right.source)
    || left.target.localeCompare(right.target)
    || left.kind.localeCompare(right.kind)
    || (left.kind === "relation" && right.kind === "relation"
      ? left.relation.predicate.localeCompare(right.relation.predicate)
      : 0)
    || left.line - right.line;
}

function addCandidate(
  candidates: Map<string, TraversalCandidate[]>,
  path: string,
  candidate: TraversalCandidate,
): void {
  const existing = candidates.get(path) ?? [];
  existing.push(candidate);
  candidates.set(path, existing);
}

function candidateKey(candidate: TraversalCandidate): string {
  return candidate.kind === "link"
    ? `link\0${edgeKey(candidate.edge)}`
    : `relation\0${relationKey(candidate.relation)}`;
}

function checkedConnections(
  analysis: VaultAnalysis,
): readonly AuthoredRelation[] {
  const authoredRelations = analysis.authoredRelations ?? [];
  const connectionCount = analysis.contextualLinks.length + authoredRelations.length;
  if (connectionCount > MAX_NAVIGATION_INDEXED_CONNECTIONS) {
    throw new NavigationBudgetError(
      "connection-work-limit",
      MAX_NAVIGATION_INDEXED_CONNECTIONS,
      `Link navigation exceeds the ${MAX_NAVIGATION_INDEXED_CONNECTIONS} `
        + "contextual-link and authored-relation observation limit.",
    );
  }
  return authoredRelations;
}

function returnedConnectionLimit(nodeLimit: number): number {
  // Preserve every edge in a simple directed graph of the returned nodes while
  // still bounding parallel typed predicates and hostile duplicate inputs.
  return Math.min(MAX_NAVIGATION_RETURNED_CONNECTIONS, nodeLimit ** 2);
}

/** Traverse explicit contextual edges without deriving relationships from similarity. */
export function navigateLinks(
  notes: readonly Note[],
  analysis: VaultAnalysis,
  start: Note,
  options: NavigateLinksOptions = {},
): LinkNeighborhood {
  const direction = options.direction ?? "both";
  const depth = checkedDepth(options.depth);
  const limit = checkedLimit(options.limit);
  const authoredRelations = checkedConnections(analysis);
  const notesByPath = new Map(notes.map((note) => [note.path, note]));
  const notesById = new Map(notes.map((note) => [note.id, note]));
  const connectionsById = new Map(
    analysis.noteConnections.map((connection) => [connection.id, connection]),
  );
  const inbound = new Map<string, TraversalCandidate[]>();
  const outbound = new Map<string, TraversalCandidate[]>();
  for (const edge of analysis.contextualLinks) {
    const candidate: TraversalCandidate = {
      kind: "link",
      source: edge.source,
      target: edge.target,
      line: edge.line,
      edge,
    };
    addCandidate(inbound, edge.target, candidate);
    addCandidate(outbound, edge.source, candidate);
  }
  for (const relation of authoredRelations) {
    const source = notesById.get(relation.source)?.path;
    const target = notesById.get(relation.target)?.path;
    if (source === undefined || target === undefined) continue;
    const candidate: TraversalCandidate = {
      kind: "relation",
      source,
      target,
      line: relation.provenance.line,
      relation,
    };
    addCandidate(inbound, target, candidate);
    addCandidate(outbound, source, candidate);
  }

  const distanceByPath = new Map<string, number>([[start.path, 0]]);
  let frontier = [start.path];
  let truncated = false;
  const selectedCandidates = new Map<string, TraversalCandidate>();
  for (let distance = 0; distance < depth && frontier.length > 0; distance += 1) {
    const next = new Set<string>();
    for (const path of frontier.toSorted()) {
      const candidates = [
        ...(direction === "out" || direction === "both" ? outbound.get(path) ?? [] : []),
        ...(direction === "in" || direction === "both" ? inbound.get(path) ?? [] : []),
      ].toSorted(compareTraversalCandidates);
      for (const candidate of candidates) {
        const neighborPath = candidate.source === path ? candidate.target : candidate.source;
        if (!notesByPath.has(neighborPath)) continue;
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

  const nodes = [...distanceByPath]
    .map(([path, distance]) => {
      const note = notesByPath.get(path);
      return note === undefined
        ? null
        : connectionNode(note, connectionsById.get(note.id), distance);
    })
    .filter((node): node is LinkNeighborhoodNode => node !== null)
    .toSorted((left, right) => left.distance - right.distance || left.path.localeCompare(right.path));
  const sortedCandidates = [...selectedCandidates.values()].toSorted(compareTraversalCandidates);
  const connectionLimit = returnedConnectionLimit(limit);
  if (sortedCandidates.length > connectionLimit) truncated = true;
  const returnedCandidates = sortedCandidates.slice(0, connectionLimit);
  const edges = returnedCandidates
    .filter((candidate): candidate is Extract<TraversalCandidate, { readonly kind: "link" }> =>
      candidate.kind === "link")
    .map(({ edge }) => edge)
    .toSorted((left, right) =>
    left.source.localeCompare(right.source)
    || left.target.localeCompare(right.target)
    || left.line - right.line);
  const relations = returnedCandidates
    .filter((candidate): candidate is Extract<TraversalCandidate, { readonly kind: "relation" }> =>
      candidate.kind === "relation")
    .map(({ relation }) => relation)
    .toSorted((left, right) =>
    left.source.localeCompare(right.source)
    || left.predicate.localeCompare(right.predicate)
    || left.target.localeCompare(right.target)
    || left.provenance.line - right.provenance.line);
  return { note: start.path, direction, depth, limit, truncated, nodes, edges, relations };
}
