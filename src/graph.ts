import { canonicalString, digest } from './canonical.js';
import type { Claim, EventIdentity, MachineState, Plan, PlanStep, Sha256 } from './model.js';
import { relationConflict, validatePlan } from './validator.js';
import { AccelerationMetrics, defaultMetrics } from './metrics.js';
import { compareStable, dependencyTerminal } from './dependency.js';

export type GraphMode = 'OFF' | 'SHADOW' | 'ON';
export type GraphNode = Readonly<{ id: string; phaseOrder: number; dependencies: readonly string[]; claims: readonly Claim[]; depth: number }>;
export type StaticGraph = Readonly<{
  schema: 'exec-static-graph/v1';
  runId: string;
  phaseId: string;
  planDigest: Sha256;
  graphDigest: Sha256;
  indexDigest: Sha256;
  nodes: readonly GraphNode[];
  predecessors: Readonly<Record<string, readonly string[]>>;
  successors: Readonly<Record<string, readonly string[]>>;
}>;

export type GraphPrepareInput = {
  runId: string;
  plan: Plan;
  state?: MachineState;
  /** State after the pure reducer event delta; graph work is post-event. */
  postEvent?: {
    baseState?: MachineState;
    baseGeneration: number;
    baseJournalEnd: number;
    baseJournalDigest: Sha256;
    identity: EventIdentity;
  };
  generation?: number;
  journalEnd?: number;
  journalDigest?: Sha256;
  authorityDigest?: Sha256;
  authorityEpoch?: number;
  maxInFlight?: number;
};

export type GraphCandidate = Readonly<{ nodeId: string; claims: readonly Claim[]; graphDigest: Sha256; generation: number; revision: number; stateDigest: Sha256 | null; journalEnd: number; journalDigest: Sha256; baseStateDigest: Sha256 | null; baseRevision: number; baseJournalEnd: number; baseJournalDigest: Sha256; authorityEpoch: number; attemptEpoch: number; barrierEpoch: number; modeEpoch: number; writerFence: string; completeFrontierDigest: Sha256 }>;
export type PreparedAcceleration = Readonly<{ boundGraph: StaticGraph; candidates: readonly GraphCandidate[]; frontierIds: readonly string[]; freshness: Readonly<{ graphDigest: Sha256; generation: number; journalEnd: number; journalDigest: Sha256; stateDigest: Sha256 | null; revision: number; baseStateDigest: Sha256 | null; baseRevision: number; baseJournalEnd: number; baseJournalDigest: Sha256; postJournalEnd: number; postJournalDigest: Sha256; authorityEpoch: number; attemptEpoch: number; barrierEpoch: number; modeEpoch: number; writerFence: string; completeFrontierDigest: Sha256 }>; diagnostics: Readonly<{ mode: GraphMode; fallback: boolean; blockerCodes: readonly string[] }>; overlay: Readonly<Record<string, string>> }>;

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function asClaim(value: Claim): Claim { return { resource: value.resource, mode: value.mode, aliases: [...new Set(value.aliases ?? [])].sort() }; }
function orderedClaims(step: PlanStep): Claim[] { return (step.claims ?? []).map(asClaim).sort((a, b) => compareStable(a.resource, b.resource) || compareStable(a.mode, b.mode)); }

function canonicalNode(step: PlanStep, depth: number, index: number): GraphNode {
  return Object.freeze({ id: step.stepId, phaseOrder: Number.isSafeInteger((step as PlanStep & { phaseOrder?: number }).phaseOrder) ? (step as PlanStep & { phaseOrder?: number }).phaseOrder! : index, dependencies: [...(step.dependencies ?? [])].sort(), claims: orderedClaims(step), depth });
}

function compile(runId: string, plan: Plan): StaticGraph {
  const validated = validatePlan(plan);
  const byId = new Map(validated.plan.steps.map((step) => [step.stepId, step]));
  const nodes = validated.order.map((id, index) => canonicalNode(byId.get(id)!, validated.depths[id], index));
  const predecessors: Record<string, readonly string[]> = {};
  const successors: Record<string, string[]> = Object.fromEntries(nodes.map((node) => [node.id, []]));
  for (const node of nodes) {
    predecessors[node.id] = [...node.dependencies];
    for (const dependency of node.dependencies) successors[dependency].push(node.id);
  }
  for (const id of Object.keys(successors)) successors[id].sort();
  const payload = { schema: 'exec-static-graph/v1' as const, runId, phaseId: validated.plan.phaseId, planDigest: digest(validated.plan), nodes, predecessors, successors };
  const graphDigest = digest(payload);
  const indexDigest = digest({ predecessors, successors, depths: Object.fromEntries(nodes.map((node) => [node.id, node.depth])) });
  return Object.freeze({ ...payload, graphDigest, indexDigest, predecessors: Object.freeze(predecessors), successors: Object.freeze(Object.fromEntries(Object.entries(successors).map(([id, values]) => [id, Object.freeze([...values])])) ) });
}

function verify(graph: StaticGraph): void {
  const payload = { schema: graph.schema, runId: graph.runId, phaseId: graph.phaseId, planDigest: graph.planDigest, nodes: graph.nodes, predecessors: graph.predecessors, successors: graph.successors };
  const indexDigest = digest({ predecessors: graph.predecessors, successors: graph.successors, depths: Object.fromEntries(graph.nodes.map((node) => [node.id, node.depth])) });
  if (digest(payload) !== graph.graphDigest || indexDigest !== graph.indexDigest) throw new Error('graph index or digest mismatch');
  const ids = new Set(graph.nodes.map((node) => node.id));
  if (ids.size !== graph.nodes.length || Object.keys(graph.predecessors).length !== ids.size || Object.keys(graph.successors).length !== ids.size) throw new Error('graph node/index set mismatch');
  for (const node of graph.nodes) {
    if (new Set(node.dependencies).size !== node.dependencies.length) throw new Error('duplicate graph edge');
    if (node.dependencies.some((dependency) => !ids.has(dependency) || dependency === node.id)) throw new Error('graph endpoint mismatch');
    if (canonicalString(graph.predecessors[node.id]) !== canonicalString(node.dependencies)) throw new Error('graph predecessor mismatch');
    for (const successor of graph.successors[node.id]) if (!ids.has(successor) || !graph.predecessors[successor].includes(node.id)) throw new Error('graph reverse index mismatch');
  }
  const visiting = new Set<string>(); const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error('graph cycle');
    if (visited.has(id)) return;
    visiting.add(id); for (const dependency of graph.predecessors[id]) visit(dependency);
    visiting.delete(id); visited.add(id);
  };
  for (const id of ids) visit(id);
}

function activeClaims(state: MachineState | undefined): Claim[] {
  return state ? Object.values(state.steps).filter((step) => step.status === 'ACTIVE').flatMap((step) => step.claims ?? []) : [];
}
function frontier(graph: StaticGraph, state: MachineState | undefined): GraphNode[] {
  if (!state) return [];
  return graph.nodes.filter((node) => state.steps[node.id]?.status === 'READY' && node.dependencies.every((dependency) => dependencyTerminal(state.steps[dependency]?.status)));
}
function selected(nodes: GraphNode[], active: Claim[], max: number): GraphNode[] {
  const picked: GraphNode[] = [];
  // The graph's deterministic ordering intentionally matches the mandatory
  // direct evaluator's validated phase/depth/ID tie-break.
  for (const node of [...nodes].sort((a, b) => a.phaseOrder - b.phaseOrder || a.depth - b.depth || compareStable(a.id, b.id))) {
    const claims = node.claims;
    if ([...active, ...picked.flatMap((candidate) => candidate.claims)].some((held) => claims.some((claim) => relationConflict(claim, held)))) continue;
    picked.push(node);
    if (picked.length >= max) break;
  }
  return picked;
}

/** Private read-only graph adapter. It never mutates MachineState or creates commands. */
export class GraphAcceleration {
  readonly #mode: GraphMode;
  readonly #metrics: AccelerationMetrics;
  #graph?: StaticGraph;
  #runId?: string;
  #planDigest?: Sha256;

  constructor(mode: GraphMode = 'OFF', metrics: AccelerationMetrics = defaultMetrics) { this.#mode = mode; this.#metrics = metrics; }

  prepare(input: GraphPrepareInput): PreparedAcceleration {
    this.#metrics.increment('graphPrepare');
    let graph: StaticGraph;
    let fallback = false;
    try {
      const planDigest = digest(validatePlan(input.plan).plan);
      if (this.#graph && this.#runId === input.runId && this.#planDigest === planDigest) graph = this.#graph;
      else { graph = compile(input.runId, input.plan); this.#graph = graph; this.#runId = input.runId; this.#planDigest = planDigest; }
      verify(graph);
    } catch {
      this.#metrics.increment('graphCorrupt'); this.#metrics.increment('graphFallback');
      graph = compile(input.runId, input.plan); fallback = true;
    }
    const state = input.state;
    const nodes = frontier(graph, state);
    const completeFrontierDigest = digest(nodes.map((node) => node.id).sort());
    const base = input.postEvent?.baseState;
    const postJournalEnd = state?.journal.length ?? 0;
    const postJournalDigest = digest(state?.journal ?? []);
    const inFlight = state ? Object.values(state.outbox).filter((command) => command.state === 'PENDING' || command.state === 'CLAIMED' || command.state === 'UNKNOWN' || (command.state === 'ACKED' && state.steps[command.stepId]?.status === 'ACTIVE')).length : 0;
    const maxInFlight = Math.max(0, (input.maxInFlight ?? Number.POSITIVE_INFINITY) - inFlight);
    let stateDigest: Sha256 | null | undefined;
    let baseStateDigest: Sha256 | null | undefined;
    const getStateDigest = (): Sha256 | null => {
      if (stateDigest === undefined) stateDigest = state ? digest(state) : null;
      return stateDigest;
    };
    const getBaseStateDigest = (): Sha256 | null => {
      if (baseStateDigest === undefined) baseStateDigest = base ? digest(base) : null;
      return baseStateDigest;
    };
    const candidates = fallback || this.#mode === 'OFF' ? [] : selected(nodes, activeClaims(state), maxInFlight).map((node) => ({ nodeId: node.id, claims: node.claims, graphDigest: graph.graphDigest, generation: input.generation ?? 0, revision: state?.revision ?? 0, stateDigest: getStateDigest(), journalEnd: postJournalEnd, journalDigest: postJournalDigest, baseStateDigest: getBaseStateDigest(), baseRevision: base?.revision ?? 0, baseJournalEnd: input.postEvent?.baseJournalEnd ?? 0, baseJournalDigest: input.postEvent?.baseJournalDigest ?? digest(base?.journal ?? []), authorityEpoch: input.authorityEpoch ?? state?.authorityEpoch ?? 0, attemptEpoch: state?.attemptEpoch ?? 0, barrierEpoch: state?.barrierEpoch ?? 0, modeEpoch: state?.modeEpoch ?? 0, writerFence: state?.writerFence ?? 'none', completeFrontierDigest }));
    this.#metrics.increment('graphCandidates', candidates.length);
    const overlay: Record<string, string> = {};
    for (const node of graph.nodes) overlay[node.id] = state?.steps[node.id]?.status ?? 'READY';
    return Object.freeze({ boundGraph: graph, candidates: Object.freeze(candidates), frontierIds: Object.freeze(nodes.map((node) => node.id).sort()), freshness: Object.freeze({ graphDigest: graph.graphDigest, generation: input.generation ?? 0, journalEnd: postJournalEnd, journalDigest: postJournalDigest, stateDigest: getStateDigest(), revision: state?.revision ?? 0, baseStateDigest: getBaseStateDigest(), baseRevision: base?.revision ?? 0, baseJournalEnd: input.postEvent?.baseJournalEnd ?? 0, baseJournalDigest: input.postEvent?.baseJournalDigest ?? digest(base?.journal ?? []), postJournalEnd, postJournalDigest, authorityEpoch: state?.authorityEpoch ?? input.authorityEpoch ?? 0, attemptEpoch: state?.attemptEpoch ?? 0, barrierEpoch: state?.barrierEpoch ?? 0, modeEpoch: state?.modeEpoch ?? 0, writerFence: state?.writerFence ?? 'none', completeFrontierDigest }), diagnostics: Object.freeze({ mode: this.#mode, fallback, blockerCodes: Object.freeze([]) }), overlay: Object.freeze(overlay) });
  }
}

export function compileStaticGraph(runId: string, plan: Plan): StaticGraph { return compile(runId, plan); }
export function validateStaticGraph(graph: StaticGraph): void { verify(graph); }
