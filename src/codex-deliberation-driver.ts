import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as dns } from 'node:dns';
import { constants as fsConstants, promises as fs } from 'node:fs';
import { lstatSync, realpathSync, statSync } from 'node:fs';
import { connect as connectTcp, createServer, isIP, type Server, type Socket } from 'node:net';
import { connect as connectTls } from 'node:tls';
import { dirname, join } from 'node:path';
import { canonicalString, digest, parseCanonical } from './canonical.js';
import {
  deriveTopology,
  materializeRoleView,
  resolveWaveSemanticClosure,
  validateReport,
  validateWave,
  type AcceptedReport,
  type DeliberationPolicy,
  type DeliberationReport,
  type DeliberationWave,
} from './deliberation.js';
import type { EffectDriver, ProviderIntentFenceObservation } from './driver.js';
import type { MachineState, OutboxCommand, Ref, Sha256 } from './model.js';
import type { DriverReceipt } from './outbox.js';
import {
  attestCodexDeliberationHost,
  buildCodexDeliberationArguments,
  buildCodexDeliberationIsolationProfile,
  validateCodexDeliberationHostPolicy,
  type CodexDeliberationHostAttestation,
  type CodexDeliberationHostPolicy,
} from './codex-host-policy.js';

export type CodexDeliberationDriverOptions = Readonly<{
  policy: CodexDeliberationHostPolicy;
  wave: Ref;
  deliberationPolicy: DeliberationPolicy;
}>;

type CommandEvidence = Readonly<Pick<OutboxCommand,
  'commandId' | 'runId' | 'phaseId' | 'stepId' | 'attemptEpoch' | 'authorityEpoch' |
  'barrierEpoch' | 'modeEpoch' | 'launchToken' | 'commandDigest'>>;

type ProviderIntentFence = Readonly<{
  schema: 'lunacy-provider-intent/v1';
  command: CommandEvidence;
  roleDigest: Sha256;
  predecessorReportDigests: readonly Sha256[];
}>;

type ReceiptEvidence = Readonly<{
  schema: 'lunacy-codex-deliberation-receipt/v2';
  command: CommandEvidence;
  roleView: Ref;
  predecessorReportDigests: readonly Sha256[];
  report: Ref;
  argvDigest: Sha256;
  environmentDigest: Sha256;
  isolationProfileDigest: Sha256;
  attestation: CodexDeliberationHostAttestation;
  transport: ModelTransportEvidenceRef;
  teardown: Ref;
}>;

type ModelTransportEvidence = Readonly<{
  schema: 'lunacy-codex-model-transport/v1';
  listener: Readonly<{ host: '127.0.0.1'; port: number }>;
  destinations: readonly ['chatgpt.com:443'];
  maxConnections: 32;
  maxBytes: number;
  connectTimeoutMs: 10_000;
  acceptedConnections: number;
  refusedConnections: number;
  totalConnections: number;
  tlsValidatedConnections: number;
  tlsRootsDigest: Sha256;
  bytesUp: number;
  bytesDown: number;
  closed: true;
  policyDigest: Sha256;
  isolationProfileDigest: Sha256;
  environmentDigest: Sha256;
}>;

type ModelTransportEvidenceRef = Readonly<Ref & {
  scope: 'outbox/model-transport';
}>;

type TeardownEvidence = Readonly<{
  schema: 'lunacy-codex-deliberation-teardown/v1';
  command: CommandEvidence;
  roleDigest: Sha256;
  predecessorReportDigests: readonly Sha256[];
  providerExited: true;
  processTreeExited: true;
  scratchRemoved: true;
  transportDigest: Sha256;
}>;

function fail(message: string): never { throw new Error(`CodexDeliberationDriver: ${message}`); }
function same(left: unknown, right: unknown): boolean { return canonicalString(left) === canonicalString(right); }
function sameRefIdentity(left: Ref, right: Ref): boolean { return left.id === right.id && left.digest === right.digest && (left.scope ?? null) === (right.scope ?? null); }
function provenance(ref: Ref): string { return canonicalString({ id: ref.id, digest: ref.digest, scope: ref.scope ?? null }); }
function launchToken(commandId: string, attemptEpoch: number, roleDigest: Sha256, predecessorReportDigests: readonly Sha256[]): string {
  return `launch-${digest({ commandId, attemptEpoch, roleDigest, predecessorReportDigests }).slice(0, 32)}`;
}
function commandDigest(command: CommandEvidence): Sha256 {
  return digest({ commandId: command.commandId, runId: command.runId, phaseId: command.phaseId, stepId: command.stepId, attemptEpoch: command.attemptEpoch, launchToken: command.launchToken });
}

const MODEL_DESTINATION = 'chatgpt.com:443' as const;
const MODEL_MAX_CONNECTIONS = 32 as const;
const MODEL_MAX_BYTES = 64 * 1024 * 1024;
const MODEL_CONNECT_TIMEOUT_MS = 10_000 as const;
const PROXY_HEADER_BYTES = 8 * 1024;
const PROXY_HEADER_TIMEOUT_MS = 1_000;
const PROXY_REQUEST_TIMEOUT_MS = 500;
const MODEL_CONNECTION_LIFETIME_MS = 60_000;
const MODEL_CLOSE_TIMEOUT_MS = 2_000;

function publicDestination(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a, b] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a! >= 224 || (a === 100 && b! >= 64 && b! <= 127)
      || (a === 169 && b === 254) || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168)
      || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51)
      || (a === 203 && b === 0));
  }
  if (family === 6) {
    const lower = address.toLowerCase();
    if (lower.startsWith('::ffff:')) return publicDestination(lower.slice('::ffff:'.length));
    return lower !== '::' && lower !== '::1' && !lower.startsWith('fe8') && !lower.startsWith('fe9')
      && !lower.startsWith('fea') && !lower.startsWith('feb') && !lower.startsWith('fc')
      && !lower.startsWith('fd') && !lower.startsWith('ff') && !lower.startsWith('2001:db8:');
  }
  return false;
}

/** Per-attempt raw CONNECT adapter. It exists only while the owned provider
 * runs. DNS and the remote socket are host-side; the sealed worker can reach
 * only this exact loopback listener. */
class ModelTransportAdapter {
  private readonly clients = new Set<Socket>();
  private readonly upstreams = new Set<Socket>();
  private readonly preflights = new Set<Socket>();
  private readonly pending = new Set<Promise<void>>();
  private readonly shutdown = new AbortController();
  private readonly lifetimeTimers = new Set<ReturnType<typeof setTimeout>>();
  private acceptedConnections = 0;
  private refusedConnections = 0;
  private totalConnections = 0;
  private tlsValidatedConnections = 0;
  private bytesUp = 0;
  private bytesDown = 0;
  private closing = false;
  private invocation: Readonly<{ isolationProfileDigest: Sha256; environmentDigest: Sha256 }> | undefined;
  private closePromise: Promise<ModelTransportEvidenceRef> | undefined;

  private constructor(private readonly server: Server, readonly port: number, private readonly policyDigest: Sha256, private readonly tlsRootsDigest: Sha256, private readonly tlsRoots: Buffer) {}

  static async start(policyDigest: Sha256, tlsRootsDigest: Sha256): Promise<ModelTransportAdapter> {
    const tlsRoots = await fs.readFile('/private/etc/ssl/cert.pem');
    if (createHash('sha256').update(tlsRoots).digest('hex') !== tlsRootsDigest) fail('model transport TLS roots changed after attestation');
    let adapter!: ModelTransportAdapter;
    const server = createServer((socket) => adapter.handle(socket));
    await new Promise<void>((resolvePromise, reject) => {
      const error = (cause: Error): void => reject(cause);
      server.once('error', error);
      server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
        server.off('error', error);
        resolvePromise();
      });
    });
    const address = server.address();
    if (!address || typeof address === 'string' || address.address !== '127.0.0.1' || address.port < 1) {
      server.close();
      fail('model transport listener identity is invalid');
    }
    adapter = new ModelTransportAdapter(server, address.port, policyDigest, tlsRootsDigest, tlsRoots);
    server.on('error', () => { void adapter.close().catch(() => undefined); });
    return adapter;
  }

  bindInvocation(isolationProfileDigest: Sha256, environmentDigest: Sha256): void {
    const binding = Object.freeze({ isolationProfileDigest, environmentDigest });
    if (this.closing || (this.invocation && !same(this.invocation, binding))) fail('model transport invocation binding changed');
    this.invocation = binding;
  }

  private refuse(socket: Socket): void {
    this.refusedConnections += 1;
    if (!socket.destroyed) socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  }

  private handle(socket: Socket): void {
    const operation = this.accept(socket).catch(() => { socket.destroy(); });
    this.pending.add(operation);
    void operation.finally(() => this.pending.delete(operation));
  }

  private readRequestChunk(client: Socket, timeoutMs: number): Promise<Buffer | undefined> {
    return new Promise((resolvePromise) => {
      let settled = false;
      const finish = (value: Buffer | undefined): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        client.off('data', onData); client.off('end', onEmpty); client.off('error', onEmpty);
        client.off('close', onEmpty); client.off('timeout', onTimeout); this.shutdown.signal.removeEventListener('abort', onAbort);
        resolvePromise(value);
      };
      const onData = (value: Buffer): void => finish(value);
      const onEmpty = (): void => finish(undefined);
      const onTimeout = (): void => { client.destroy(); finish(undefined); };
      const onAbort = (): void => { client.destroy(); finish(undefined); };
      const timer = setTimeout(() => { client.destroy(); finish(undefined); }, Math.max(1, timeoutMs));
      client.once('data', onData); client.once('end', onEmpty); client.once('error', onEmpty);
      client.once('close', onEmpty); client.once('timeout', onTimeout); this.shutdown.signal.addEventListener('abort', onAbort, { once: true });
      if (this.shutdown.signal.aborted) onAbort();
    });
  }

  private boundedLookup(): Promise<readonly { address: string; family: number }[]> {
    return new Promise((resolvePromise) => {
      let settled = false;
      const finish = (value: readonly { address: string; family: number }[]): void => {
        if (settled) return; settled = true; clearTimeout(timer); this.shutdown.signal.removeEventListener('abort', onAbort); resolvePromise(value);
      };
      const onAbort = (): void => finish([]);
      const timer = setTimeout(() => finish([]), MODEL_CONNECT_TIMEOUT_MS);
      this.shutdown.signal.addEventListener('abort', onAbort, { once: true });
      void dns.lookup('chatgpt.com', { all: true, verbatim: true }).then(finish, () => finish([]));
      if (this.shutdown.signal.aborted) onAbort();
    });
  }

  private async accept(client: Socket): Promise<void> {
    this.totalConnections += 1;
    this.clients.add(client);
    client.once('close', () => this.clients.delete(client));
    client.on('error', () => client.destroy());
    client.setTimeout(PROXY_REQUEST_TIMEOUT_MS);
    if (this.closing || this.totalConnections > MODEL_MAX_CONNECTIONS) { client.destroy(); return; }
    let header = Buffer.alloc(0);
    const headerDeadline = Date.now() + PROXY_HEADER_TIMEOUT_MS;
    while (!header.includes('\r\n\r\n') && header.length <= PROXY_HEADER_BYTES) {
      const remaining = headerDeadline - Date.now();
      if (remaining <= 0) { client.destroy(); return; }
      const next = await this.readRequestChunk(client, Math.min(PROXY_REQUEST_TIMEOUT_MS, remaining));
      if (!next) return;
      header = Buffer.concat([header, next]);
    }
    const boundary = header.indexOf('\r\n\r\n');
    if (boundary < 0 || boundary > PROXY_HEADER_BYTES) { this.refuse(client); return; }
    const lines = header.subarray(0, boundary).toString('ascii').split('\r\n');
    if (lines[0] !== `CONNECT ${MODEL_DESTINATION} HTTP/1.1` || lines.slice(1).some((line) => /^proxy-authorization\s*:/i.test(line))) { this.refuse(client); return; }
    const resolved = await this.boundedLookup();
    const destinations = resolved.filter((row) => publicDestination(row.address));
    if (destinations.length === 0 || this.closing) { this.refuse(client); return; }
    const destination = destinations[0]!;
    if (!await this.validateTlsDestination(destination)) { this.refuse(client); return; }
    this.tlsValidatedConnections += 1;
    const upstream = connectTcp({ host: destination.address, port: 443, family: destination.family });
    this.upstreams.add(upstream);
    upstream.once('close', () => this.upstreams.delete(upstream));
    upstream.on('error', () => { client.destroy(); upstream.destroy(); });
    upstream.setTimeout(MODEL_CONNECT_TIMEOUT_MS, () => upstream.destroy());
    const connected = await new Promise<boolean>((resolvePromise) => {
      let settled = false;
      const done = (value: boolean): void => {
        if (settled) return; settled = true; clearTimeout(timer);
        upstream.off('connect', ok); upstream.off('error', no); upstream.off('close', no); upstream.off('timeout', no);
        this.shutdown.signal.removeEventListener('abort', abort); resolvePromise(value);
      };
      const ok = (): void => done(true); const no = (): void => done(false);
      const abort = (): void => { upstream.destroy(); done(false); };
      const timer = setTimeout(abort, MODEL_CONNECT_TIMEOUT_MS);
      upstream.once('connect', ok); upstream.once('error', no); upstream.once('close', no); upstream.once('timeout', no);
      this.shutdown.signal.addEventListener('abort', abort, { once: true });
      if (this.shutdown.signal.aborted) abort();
    });
    if (!connected || this.closing) { upstream.destroy(); this.refuse(client); return; }
    this.acceptedConnections += 1;
    client.setTimeout(0); upstream.setTimeout(0);
    const lifetime = setTimeout(() => { client.destroy(); upstream.destroy(); }, MODEL_CONNECTION_LIFETIME_MS);
    this.lifetimeTimers.add(lifetime);
    let lifetimeSettled = false;
    const clearLifetime = (): void => {
      if (lifetimeSettled) return; lifetimeSettled = true; clearTimeout(lifetime); this.lifetimeTimers.delete(lifetime);
    };
    client.once('close', clearLifetime); upstream.once('close', clearLifetime);
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    const tail = header.subarray(boundary + 4);
    if (tail.length > 0) { this.bytesUp += tail.length; upstream.write(tail); }
    const bounded = (direction: 'up' | 'down', size: number): void => {
      if (direction === 'up') this.bytesUp += size; else this.bytesDown += size;
      if (this.bytesUp + this.bytesDown > MODEL_MAX_BYTES) { client.destroy(); upstream.destroy(); }
    };
    client.on('data', (value: Buffer) => bounded('up', value.length));
    upstream.on('data', (value: Buffer) => bounded('down', value.length));
    client.pipe(upstream); upstream.pipe(client);
  }

  private validateTlsDestination(destination: { address: string; family: number }): Promise<boolean> {
    return new Promise((resolvePromise) => {
      const socket = connectTls({ host: destination.address, port: 443, servername: 'chatgpt.com', rejectUnauthorized: true, ca: this.tlsRoots });
      this.preflights.add(socket);
      let settled = false;
      const timer = setTimeout(() => finish(false), MODEL_CONNECT_TIMEOUT_MS);
      const finish = (valid: boolean): void => {
        if (settled) return; settled = true; clearTimeout(timer); this.shutdown.signal.removeEventListener('abort', abort);
        this.preflights.delete(socket); socket.destroy(); resolvePromise(valid);
      };
      const abort = (): void => finish(false);
      socket.once('secureConnect', () => finish(socket.authorized && socket.authorizationError === null));
      socket.once('error', () => finish(false));
      socket.once('close', () => finish(false));
      this.shutdown.signal.addEventListener('abort', abort, { once: true });
      if (this.shutdown.signal.aborted) abort();
    });
  }

  private async shutdownAndFinalize(): Promise<ModelTransportEvidenceRef> {
    if (!this.invocation) fail('model transport invocation was not bound');
    const closed = new Promise<void>((resolvePromise, reject) => {
      this.server.close((cause) => cause ? reject(cause) : resolvePromise());
    });
    for (const timer of this.lifetimeTimers) clearTimeout(timer);
    this.lifetimeTimers.clear();
    for (const socket of [...this.clients, ...this.upstreams, ...this.preflights]) socket.destroy();
    await Promise.all([closed, Promise.allSettled([...this.pending])]);
    const drainDeadline = Date.now() + MODEL_CLOSE_TIMEOUT_MS - 100;
    while (this.clients.size !== 0 || this.upstreams.size !== 0 || this.preflights.size !== 0 || this.pending.size !== 0) {
      for (const socket of [...this.clients, ...this.upstreams, ...this.preflights]) socket.destroy();
      if (Date.now() >= drainDeadline) break;
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
    }
    if (this.clients.size !== 0 || this.upstreams.size !== 0 || this.preflights.size !== 0 || this.pending.size !== 0) {
      fail('model transport retained live resources after close');
    }
    const summary: ModelTransportEvidence = Object.freeze({
      schema: 'lunacy-codex-model-transport/v1', listener: Object.freeze({ host: '127.0.0.1', port: this.port }),
      destinations: [MODEL_DESTINATION] as const, maxConnections: MODEL_MAX_CONNECTIONS, maxBytes: MODEL_MAX_BYTES,
      connectTimeoutMs: MODEL_CONNECT_TIMEOUT_MS, acceptedConnections: this.acceptedConnections,
      refusedConnections: this.refusedConnections, totalConnections: this.totalConnections, tlsValidatedConnections: this.tlsValidatedConnections,
      tlsRootsDigest: this.tlsRootsDigest, bytesUp: this.bytesUp, bytesDown: this.bytesDown,
      closed: true, policyDigest: this.policyDigest, isolationProfileDigest: this.invocation.isolationProfileDigest,
      environmentDigest: this.invocation.environmentDigest,
    });
    const evidenceDigest = digest(summary);
    return Object.freeze({ id: `model-transport:${evidenceDigest}`, scope: 'outbox/model-transport', digest: evidenceDigest, bytes: canonicalString(summary) });
  }

  async close(): Promise<ModelTransportEvidenceRef> {
    if (!this.closePromise) {
      this.closing = true;
      this.shutdown.abort();
      this.closePromise = new Promise<ModelTransportEvidenceRef>((resolvePromise, reject) => {
        const timer = setTimeout(() => reject(new Error('model transport close deadline exceeded')), MODEL_CLOSE_TIMEOUT_MS);
        void this.shutdownAndFinalize().then(
          (value) => { clearTimeout(timer); resolvePromise(value); },
          (cause) => { clearTimeout(timer); reject(cause); },
        );
      });
    }
    return this.closePromise;
  }
}

/** Real managed-provider entry. Provider stdin is exactly the immutable,
 * bounded role view committed by prepare in the claim CAS. Durable recovery
 * evidence lives outside the per-attempt provider scratch directory. */
export class CodexDeliberationDriver implements EffectDriver {
  private readonly policy: CodexDeliberationHostPolicy;
  private readonly waveRef: Ref;
  private readonly wave: DeliberationWave;
  private readonly deliberationPolicy: DeliberationPolicy;
  private readonly constructionIdentity: ReadonlyArray<Readonly<{ path: string; physicalPath: string; requestedDev: number; requestedIno: number; requestedMode: number; dev: number; ino: number; mode: number }>>;

  constructor(options: CodexDeliberationDriverOptions) {
    if (!options || typeof options !== 'object') fail('options are required');
    this.policy = validateCodexDeliberationHostPolicy(options.policy);
    if (!options.wave || options.wave.scope !== 'deliberation/wave' || typeof options.wave.bytes !== 'string') fail('Wave Ref is invalid');
    let wave: DeliberationWave;
    try { wave = parseCanonical<DeliberationWave>(options.wave.bytes); }
    catch { fail('Wave Ref is invalid'); }
    if (digest(wave) !== options.wave.digest) fail('Wave Ref is invalid');
    const closure = resolveWaveSemanticClosure(wave);
    if (!closure.ok) fail(`Wave semantic closure is invalid: ${closure.message}`);
    const validated = validateWave(wave, { runId: wave.authorship.runId, phaseId: wave.authorship.phaseId, policy: options.deliberationPolicy, committedEvidence: closure.value.committedEvidence, reachableConstraints: closure.value.reachableConstraints });
    if (!validated.ok) fail(`Wave is not admitted by deliberation policy: ${validated.message}`);
    this.waveRef = Object.freeze(JSON.parse(JSON.stringify(options.wave)) as Ref);
    this.wave = Object.freeze(JSON.parse(JSON.stringify(validated.value)) as DeliberationWave);
    this.deliberationPolicy = Object.freeze(JSON.parse(JSON.stringify(options.deliberationPolicy)) as DeliberationPolicy);
    try {
      this.constructionIdentity = Object.freeze([
        this.policy.codexPath,
        this.policy.authFilePath,
        this.policy.workerSchemaPath,
        ...this.policy.runtimeReadFiles,
        ...this.policy.runtimeReadSubpaths,
        ...this.policy.runtimeReadFiles.flatMap((path) => {
          const links: string[] = []; const parts = path.split('/').filter(Boolean); let current = '/';
          for (const part of parts) { current = join(current, part); try { if (lstatSync(current).isSymbolicLink()) links.push(current); } catch { /* constructor reports below */ } }
          return links;
        }),
        this.policy.targetWorkspace,
        this.policy.scratchRoot,
        this.policy.evidenceRoot,
        this.policy.sandboxExecPath,
      ].map((path) => {
        const physicalPath = realpathSync(path); const requested = lstatSync(path); const stat = statSync(physicalPath);
        return Object.freeze({ path, physicalPath, requestedDev: requested.dev, requestedIno: requested.ino, requestedMode: requested.mode, dev: stat.dev, ino: stat.ino, mode: stat.mode });
      }));
    } catch (error) { fail(`host identity is unavailable: ${(error as Error).message}`); }
  }

  get hostPolicy(): CodexDeliberationHostPolicy { return this.policy; }

  /** Trusted composition-only preparation. This mutates only the cloned state
   * that the coordinator is about to CAS as the claimed command. */
  prepare(command: OutboxCommand, state: MachineState): void {
    if (command.state !== 'PENDING' || state.outbox[command.commandId] !== command) fail('prepare requires the authoritative pending command');
    if (state.modeEpoch !== 0 || command.modeEpoch !== 0) fail('modeEpoch is unsupported');
    if (state.schema !== 2 || !state.managed?.proposal || state.managed.proposal.planDigest !== state.planDigest
      || !state.managed.proposal.roleWaveRef || !same(state.managed.proposal.roleWaveRef, this.waveRef)) fail('prepare requires the authoritative managed Wave plan');
    if (command.runId !== state.runId || command.phaseId !== state.phaseId || command.attemptEpoch !== state.attemptEpoch
      || command.authorityEpoch !== state.authorityEpoch || command.barrierEpoch !== state.barrierEpoch || command.modeEpoch !== state.modeEpoch) fail('prepare command is outside the current frame');
    const topology = deriveTopology(this.waveRef, this.wave);
    const slot = topology.slots.find((candidate) => candidate.stepId === command.stepId);
    if (!slot) fail('command does not name a derived Wave slot');

    const acceptedReportsByRef = new Map<string, AcceptedReport>();
    const rowsBySlot = new Map<number, Ref[]>();
    for (const row of Object.values(state.managed.acceptedReports ?? {})) {
      const owner = state.outbox[row.commandId];
      if (!owner || owner.state !== 'ACKED' || owner.attemptEpoch !== command.attemptEpoch
        || owner.authorityEpoch !== command.authorityEpoch || owner.barrierEpoch !== command.barrierEpoch || owner.modeEpoch !== command.modeEpoch
        || !same(row.report.wave, this.waveRef)) continue;
      // The accepted row is authoritative state and therefore retains its
      // private authority-anchor digest.  Role materialization consumes the
      // deliberately smaller public receipt contract only: predecessor
      // providers receive no authority metadata or state-owner capability.
      // The provider-facing deliberation contract uses the canonical Report
      // identity derived from Report bytes.  The authoritative managed-report
      // id also embeds the private role digest, so it must not cross this
      // projection seam either.
      const predecessorRef: Ref = {
        id: `report:${row.ref.digest.slice(0, 16)}`,
        scope: 'deliberation/report',
        digest: row.ref.digest,
        ...(row.ref.bytes === undefined ? {} : { bytes: row.ref.bytes }),
      };
      const envelope: AcceptedReport = {
        ref: predecessorRef,
        report: JSON.parse(JSON.stringify(row.report)) as DeliberationReport,
        receipt: {
          commandDigest: row.receipt.commandDigest,
          resultDigest: row.receipt.resultDigest,
          attemptEpoch: row.receipt.attemptEpoch,
        },
      };
      acceptedReportsByRef.set(provenance(predecessorRef), envelope);
      const refs = rowsBySlot.get(row.report.slotOrdinal) ?? [];
      refs.push({ ...predecessorRef });
      rowsBySlot.set(row.report.slotOrdinal, refs);
    }
    const predecessorRefs = slot.dependencies.map((ordinal) => {
      const refs = rowsBySlot.get(ordinal) ?? [];
      if (refs.length !== 1) fail(`slot ${slot.slotOrdinal} requires exactly one accepted predecessor for slot ${ordinal}`);
      return refs[0]!;
    });
    const closure = resolveWaveSemanticClosure(this.wave);
    if (!closure.ok) fail(`sealed role input closure is invalid: ${closure.message}`);
    const resolved = closure.value.resolved;
    const materialized = materializeRoleView({ waveRef: this.waveRef, wave: this.wave, slot, predecessorRefs, acceptedReportsByRef, resolved, policy: this.deliberationPolicy });
    if (!materialized.ok) fail(`role materialization failed: ${materialized.code} ${materialized.message}`);
    const bytes = canonicalString(materialized.value);
    if (Buffer.byteLength(bytes, 'utf8') > this.wave.limits.maxResolvedRoleInputBytes
      || Buffer.byteLength(bytes, 'utf8') > this.deliberationPolicy.maxResolvedRoleInputBytes) fail('materialized role view exceeds byte ceiling');
    const roleDigest = digest(materialized.value);
    const predecessorReportDigests = predecessorRefs.map((ref) => ref.digest);
    command.roleView = { id: `role-view:${roleDigest}`, scope: 'deliberation/role-view', digest: roleDigest, bytes };
    command.predecessorReportDigests = predecessorReportDigests;
    command.launchToken = launchToken(command.commandId, command.attemptEpoch, roleDigest, predecessorReportDigests);
    command.commandDigest = commandDigest(command);
  }

  async dispatch(command: OutboxCommand, token: string, signal?: AbortSignal): Promise<DriverReceipt> {
    const role = this.validateCommand(command, token);
    if (signal?.aborted) fail('launch was cancelled before attestation');
    this.assertConstructionIdentity();
    const attestation = await attestCodexDeliberationHost(this.policy);
    this.assertConstructionIdentity();
    if (signal?.aborted) fail('launch was cancelled before spawn');
    const paths = this.paths(token);
    const args = buildCodexDeliberationArguments(this.policy, paths.output);
    let attemptCreated = false;
    let providerLaunched = false;
    let providerExited = false;
    let teardownRef: Ref | undefined;
    let ownsTeardown = false;
    let transport: ModelTransportAdapter | undefined;
    let transportEvidence: ModelTransportEvidenceRef | undefined;
    let transportPersisted = false;
    try {
      const receiptExists = await fs.lstat(paths.receipt).then(() => true, (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return false;
        throw error;
      });
      if (receiptExists) fail('launch token already has durable evidence');
      ownsTeardown = true;
      await fs.mkdir(paths.attempt, { mode: 0o700 });
      await fs.mkdir(paths.authHome, { mode: 0o700 });
      await fs.writeFile(join(paths.authHome, 'auth.json'), await fs.readFile(this.policy.authFilePath), { flag: 'wx', mode: 0o600 });
      attemptCreated = true;
      transport = await ModelTransportAdapter.start(attestation.modelTransport.digest as Sha256, attestation.readIsolation.tlsRoots.digest as Sha256);
      const isolationProfile = buildCodexDeliberationIsolationProfile(this.policy, paths.attempt, transport.port);
      const isolatedArgs = ['-p', isolationProfile, attestation.executable.physicalPath, ...args];
      const environment = this.childEnvironment(paths.attempt, paths.authHome, transport.port);
      const isolationProfileDigest = digest(isolationProfile);
      const environmentDigest = digest(environment);
      transport.bindInvocation(isolationProfileDigest, environmentDigest);
      // Every retryable preparation and frozen-identity check is complete
      // before this permanent fence.  Once its file and parent directory are
      // durable, provider replacement is forbidden for this attempt forever.
      const beforeFence = await attestCodexDeliberationHost(this.policy);
      this.assertConstructionIdentity();
      if (!same(attestation, beforeFence)) fail('host identity changed before provider intent');
      await this.writeProviderIntentFence(paths.reservation, command);
      providerLaunched = true;
      const providerError = await this.run(attestation.readIsolation.executable.path, isolatedArgs, command.roleView!.bytes!, paths.attempt, environment, signal);
      providerExited = true;
      const [firstClose, concurrentClose] = await Promise.all([transport.close(), transport.close()]);
      const repeatedClose = await transport.close();
      if (!same(firstClose, concurrentClose) || !same(firstClose, repeatedClose)) fail('model transport close was not idempotent');
      transportEvidence = firstClose;
      transport = undefined;
      const transportSummary = this.parseTransportEvidence(transportEvidence);
      if (!this.validTransportEvidence(transportSummary, attestation.modelTransport.digest, attestation.readIsolation.tlsRoots.digest, isolationProfileDigest, environmentDigest)) fail('model transport exceeded or escaped its attested policy');
      await this.writeTransportEvidence(paths, transportEvidence);
      transportPersisted = true;
      if (providerError) throw providerError;
      const report = await this.readReport(paths.output);
      const predecessors = this.rolePredecessors(role);
      const topology = deriveTopology(this.waveRef, this.wave);
      const slot = topology.slots.find((candidate) => candidate.stepId === command.stepId)!;
      const validated = validateReport(report, { waveRef: this.waveRef, wave: this.wave, slot, predecessors, policy: this.deliberationPolicy });
      if (!validated.ok) fail(`provider report is invalid: ${validated.code} ${validated.message}`);
      const reportBytes = canonicalString(validated.value);
      const reportDigest = digest(validated.value);
      const reportRef: Ref = { id: `managed-report:${command.roleView!.digest}:${reportDigest}`, scope: 'deliberation/report', digest: reportDigest, bytes: reportBytes };
      await this.removeScratch(paths);
      attemptCreated = false;
      teardownRef = await this.writeTeardown(paths, command, transportEvidence);
      const evidence: ReceiptEvidence = {
        schema: 'lunacy-codex-deliberation-receipt/v2',
        command: this.commandEvidence(command),
        roleView: { ...command.roleView! },
        predecessorReportDigests: [...command.predecessorReportDigests!],
        report: reportRef,
        argvDigest: digest(isolatedArgs),
        environmentDigest,
        isolationProfileDigest,
        attestation,
        transport: transportEvidence,
        teardown: teardownRef,
      };
      await fs.writeFile(paths.receipt, canonicalString(evidence), { flag: 'wx', mode: 0o600 });
      return { launchToken: token, commandDigest: command.commandDigest, ref: reportRef, authorityAnchor: this.receiptAuthorityAnchor(evidence) };
    } finally {
      if (transport) {
        transportEvidence = await transport.close(); transport = undefined;
        if (!transportPersisted) { await this.writeTransportEvidence(paths, transportEvidence); transportPersisted = true; }
      }
      if (attemptCreated && !providerLaunched) { await this.removeScratch(paths); attemptCreated = false; }
      if (attemptCreated && providerExited && transportPersisted) { await this.removeScratch(paths); attemptCreated = false; }
      if (ownsTeardown && providerExited && transportEvidence && transportPersisted && !teardownRef) teardownRef = await this.writeTeardown(paths, command, transportEvidence);
    }
  }

  async observeProviderIntent(token: string, expectedCommandDigest: string, retainedCommand?: OutboxCommand): Promise<ProviderIntentFenceObservation> {
    if (!retainedCommand || token !== retainedCommand.launchToken || expectedCommandDigest !== retainedCommand.commandDigest || !retainedCommand.roleView) return { kind: 'AMBIGUOUS' };
    const path = this.paths(token).reservation;
    let raw: string;
    try { raw = await fs.readFile(path, 'utf8'); }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'ABSENT_PROVED' } : { kind: 'AMBIGUOUS' }; }
    try {
      const value = parseCanonical<ProviderIntentFence>(raw);
      if (canonicalString(value) !== raw || value.schema !== 'lunacy-provider-intent/v1'
        || Object.keys(value).sort().join(',') !== 'command,predecessorReportDigests,roleDigest,schema'
        || !same(value.command, this.commandEvidence(retainedCommand))
        || value.roleDigest !== retainedCommand.roleView.digest
        || !same(value.predecessorReportDigests, retainedCommand.predecessorReportDigests ?? [])) return { kind: 'AMBIGUOUS' };
      const fence: Ref = { id: `provider-intent:${digest(value)}`, scope: 'outbox/provider-intent', digest: digest(value), bytes: raw };
      return { kind: 'PRESENT_VALID', fence };
    } catch { return { kind: 'AMBIGUOUS' }; }
  }

  async observe(token: string, signal?: AbortSignal, authorityAnchor?: Ref, retainedCommand?: OutboxCommand): Promise<DriverReceipt | undefined> {
    if (typeof token !== 'string' || token.length === 0 || signal?.aborted) return undefined;
    try {
      const paths = this.paths(token);
      const raw = await fs.readFile(paths.receipt, 'utf8');
      const evidence = parseCanonical<ReceiptEvidence>(raw);
      if (canonicalString(evidence) !== raw || evidence.schema !== 'lunacy-codex-deliberation-receipt/v2'
        || Object.keys(evidence).sort().join(',') !== 'argvDigest,attestation,command,environmentDigest,isolationProfileDigest,predecessorReportDigests,report,roleView,schema,teardown,transport'
        || Object.keys(evidence.command).sort().join(',') !== 'attemptEpoch,authorityEpoch,barrierEpoch,commandDigest,commandId,launchToken,modeEpoch,phaseId,runId,stepId') return undefined;
      if (evidence.command.modeEpoch !== 0 || evidence.command.launchToken !== token || evidence.command.commandDigest !== commandDigest(evidence.command)) return undefined;
      if (retainedCommand && (retainedCommand.modeEpoch !== 0 || !same(evidence.command, this.commandEvidence(retainedCommand)))) return undefined;
      if (!evidence.roleView || evidence.roleView.scope !== 'deliberation/role-view' || typeof evidence.roleView.bytes !== 'string'
        || digest(parseCanonical(evidence.roleView.bytes)) !== evidence.roleView.digest) return undefined;
      if (!Array.isArray(evidence.predecessorReportDigests) || evidence.predecessorReportDigests.some((value) => !/^[0-9a-f]{64}$/.test(value))) return undefined;
      if (token !== launchToken(evidence.command.commandId, evidence.command.attemptEpoch, evidence.roleView.digest, evidence.predecessorReportDigests)) return undefined;
      if (evidence.report.id !== `managed-report:${evidence.roleView.digest}:${evidence.report.digest}` || evidence.report.scope !== 'deliberation/report' || typeof evidence.report.bytes !== 'string') return undefined;
      const report = parseCanonical<DeliberationReport>(evidence.report.bytes);
      if (digest(report) !== evidence.report.digest || !sameRefIdentity(report.wave, this.waveRef)) return undefined;
      const role = parseCanonical<Record<string, any>>(evidence.roleView.bytes);
      const slot = deriveTopology(this.waveRef, this.wave).slots.find((candidate) => candidate.stepId === evidence.command.stepId);
      if (!slot || role.kind !== slot.role) return undefined;
      try { this.assertRoleProjection(role, slot.role); } catch { return undefined; }
      if (!same(this.rolePredecessorDigests(role), evidence.predecessorReportDigests)) return undefined;
      const predecessors = this.rolePredecessors(role);
      const validated = validateReport(report, { waveRef: this.waveRef, wave: this.wave, slot, predecessors, policy: this.deliberationPolicy });
      if (!validated.ok || canonicalString(validated.value) !== evidence.report.bytes) return undefined;
      const attestation = evidence.attestation;
      if (attestation.policyDigest !== digest(this.policy)) return undefined;
      const transportSummary = await this.readTransportEvidence(paths, evidence.transport);
      const isolationProfile = buildCodexDeliberationIsolationProfile(this.policy, paths.attempt, transportSummary.listener.port);
      const isolatedArgs = ['-p', isolationProfile, attestation.executable.physicalPath, ...buildCodexDeliberationArguments(this.policy, paths.output)];
      const environment = this.childEnvironment(paths.attempt, paths.authHome, transportSummary.listener.port);
      if (!this.validTransportEvidence(transportSummary, attestation.modelTransport.digest, attestation.readIsolation.tlsRoots.digest, digest(isolationProfile), digest(environment))) return undefined;
      if (evidence.argvDigest !== digest(isolatedArgs) || evidence.environmentDigest !== digest(environment) || evidence.isolationProfileDigest !== digest(isolationProfile)) return undefined;
      const teardown = await this.observeTeardown(token, evidence.command.commandDigest, signal);
      if (!teardown || !same(teardown, evidence.teardown)) return undefined;
      if (parseCanonical<TeardownEvidence>(teardown.bytes!).transportDigest !== evidence.transport.digest) return undefined;
      const scratchAbsent = await fs.lstat(paths.attempt).then(() => false, (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
      const authAbsent = await fs.lstat(paths.authHome).then(() => false, (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
      if (!scratchAbsent || !authAbsent) return undefined;
      const observedAnchor = this.receiptAuthorityAnchor(evidence);
      if (authorityAnchor && !same(authorityAnchor, observedAnchor)) return undefined;
      return { launchToken: token, commandDigest: evidence.command.commandDigest, ref: { ...evidence.report }, authorityAnchor: observedAnchor };
    } catch { return undefined; }
  }

  async observeTeardown(token: string, expectedCommandDigest: string, signal?: AbortSignal): Promise<Ref | undefined> {
    if (typeof token !== 'string' || token.length === 0 || !/^[0-9a-f]{64}$/.test(expectedCommandDigest) || signal?.aborted) return undefined;
    try {
      const paths = this.paths(token); const raw = await fs.readFile(paths.teardown, 'utf8'); const evidence = parseCanonical<TeardownEvidence>(raw);
      if (canonicalString(evidence) !== raw || evidence.schema !== 'lunacy-codex-deliberation-teardown/v1'
        || Object.keys(evidence).sort().join(',') !== 'command,predecessorReportDigests,processTreeExited,providerExited,roleDigest,schema,scratchRemoved,transportDigest'
        || Object.keys(evidence.command).sort().join(',') !== 'attemptEpoch,authorityEpoch,barrierEpoch,commandDigest,commandId,launchToken,modeEpoch,phaseId,runId,stepId'
        || evidence.command.modeEpoch !== 0 || evidence.command.launchToken !== token || evidence.command.commandDigest !== expectedCommandDigest || evidence.command.commandDigest !== commandDigest(evidence.command)
        || evidence.roleDigest === undefined || !/^[0-9a-f]{64}$/.test(evidence.roleDigest) || !Array.isArray(evidence.predecessorReportDigests)
        || evidence.predecessorReportDigests.some((value) => !/^[0-9a-f]{64}$/.test(value)) || evidence.providerExited !== true || evidence.processTreeExited !== true || evidence.scratchRemoved !== true
        || !/^[0-9a-f]{64}$/.test(evidence.transportDigest)) return undefined;
      if (token !== launchToken(evidence.command.commandId, evidence.command.attemptEpoch, evidence.roleDigest, evidence.predecessorReportDigests)) return undefined;
      const transport = await this.readTransportEvidence(paths);
      if (digest(transport) !== evidence.transportDigest) return undefined;
      if (!transport.closed) return undefined;
      const scratchAbsent = await fs.lstat(paths.attempt).then(() => false, (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
      const authAbsent = await fs.lstat(paths.authHome).then(() => false, (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
      if (!scratchAbsent || !authAbsent) return undefined;
      return { id: `teardown:${digest(evidence)}`, scope: 'outbox/teardown', digest: digest(evidence), bytes: raw };
    } catch { return undefined; }
  }

  private validateCommand(command: OutboxCommand, token: string): Record<string, any> {
    if (!command || command.state !== 'CLAIMED') fail('dispatch requires a claimed command');
    if (command.modeEpoch !== 0) fail('modeEpoch is unsupported');
    if (token !== command.launchToken) fail('launch token mismatch');
    if (!command.roleView || command.roleView.scope !== 'deliberation/role-view' || typeof command.roleView.bytes !== 'string') fail('command has no materialized role view');
    let role: Record<string, any>;
    try { role = parseCanonical<Record<string, any>>(command.roleView.bytes); }
    catch { fail('role view is not canonical'); }
    if (digest(role) !== command.roleView.digest || command.roleView.id !== `role-view:${command.roleView.digest}`) fail('role view digest mismatch');
    if (!Array.isArray(command.predecessorReportDigests) || command.predecessorReportDigests.some((value) => !/^[0-9a-f]{64}$/.test(value))) fail('predecessor digest binding is invalid');
    if (token !== launchToken(command.commandId, command.attemptEpoch, command.roleView.digest, command.predecessorReportDigests)) fail('launch token is not role-bound');
    if (command.commandDigest !== commandDigest(command)) fail('command digest mismatch');
    const slot = deriveTopology(this.waveRef, this.wave).slots.find((candidate) => candidate.stepId === command.stepId);
    if (!slot || role.kind !== slot.role || command.predecessorReportDigests.length !== slot.dependencies.length) fail('role view does not match command slot');
    this.assertRoleProjection(role, slot.role);
    if (!same(this.rolePredecessorDigests(role), command.predecessorReportDigests)) fail('role view predecessor content is not digest-bound');
    return role;
  }

  private assertRoleProjection(role: Record<string, any>, kind: 'GENERATOR' | 'CRITIC' | 'DEEPENER'): void {
    const discriminator = Object.prototype.hasOwnProperty.call(role, 'discriminator') ? ['discriminator'] : [];
    const roleKeys = kind === 'GENERATOR'
      ? ['constraints', 'contract', 'decisionImpact', ...discriminator, 'evidence', 'kind', 'lens', 'question']
      : kind === 'CRITIC'
        ? ['constraints', 'contract', 'decisionImpact', ...discriminator, 'evidence', 'generators', 'kind', 'question']
        : ['constraints', 'contract', 'critic', 'decisionImpact', ...discriminator, 'evidence', 'kind', 'question', 'selected'];
    if (Object.keys(role).sort().join(',') !== roleKeys.sort().join(',')) fail('role projection fields are not closed');
    const assertRoleRef = (value: any): void => {
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !['id', 'digest', 'scope'].includes(key))
        || typeof value.id !== 'string' || !/^[0-9a-f]{64}$/.test(String(value.digest)) || value.bytes !== undefined) fail('role projection Ref is malformed');
    };
    const assertNoPrivateFields = (value: any): void => {
      if (!value || typeof value !== 'object') return;
      if (Object.keys(value).some((key) => ['bytes', 'authorship', 'authorityDigest', 'gear', 'generatorLenses', 'limits'].includes(key))) fail('role projection contains private Wave data');
      for (const nested of Object.values(value)) assertNoPrivateFields(nested);
    };
    const assertBound = (bound: any, reportKeys: readonly string[]): void => {
      if (!bound || typeof bound !== 'object' || Array.isArray(bound) || Object.keys(bound).sort().join(',') !== 'ref,report') fail('role predecessor binding is malformed');
      assertRoleRef(bound.ref); assertNoPrivateFields(bound.report);
      if (!bound.report || Object.keys(bound.report).sort().join(',') !== [...reportKeys].sort().join(',')) fail('role predecessor Report fields are not closed');
      assertRoleRef(bound.report.wave);
    };
    if (kind === 'GENERATOR') {
      if (!role.lens || !['text', 'tags,text'].includes(Object.keys(role.lens).sort().join(',')) || typeof role.lens.text !== 'string'
        || (role.lens.tags !== undefined && (!Array.isArray(role.lens.tags) || role.lens.tags.length === 0 || role.lens.tags.some((tag: unknown) => !['code', 'design', 'general', 'wild'].includes(String(tag)))))) fail('generator lens projection is malformed');
    } else if (kind === 'CRITIC') {
      if (!Array.isArray(role.generators)) fail('critic predecessor projection is malformed');
      for (const bound of role.generators) assertBound(bound, ['schema', 'wave', 'slotOrdinal', 'ideas']);
    } else {
      assertBound(role.critic, ['schema', 'wave', 'slotOrdinal', 'scores', 'clusters']);
      if (!role.selected || Object.keys(role.selected).sort().join(',') !== 'generatorReport,idea,oneBasedOrdinal' || !role.selected.idea
        || Object.keys(role.selected.idea).sort().join(',') !== 'rationale,text') fail('deepener selection projection is malformed');
      assertRoleRef(role.selected.generatorReport);
    }
  }

  private rolePredecessorDigests(role: Record<string, any>): Sha256[] {
    if (role.kind === 'GENERATOR') return [];
    if (role.kind === 'CRITIC' && Array.isArray(role.generators)) return role.generators.map((bound: any) => {
      if (!bound || Object.keys(bound).sort().join(',') !== 'ref,report' || typeof bound.ref?.digest !== 'string') fail('critic predecessor projection is malformed');
      return bound.ref.digest as Sha256;
    });
    if (role.kind === 'DEEPENER' && role.critic && Object.keys(role.critic).sort().join(',') === 'ref,report' && typeof role.critic.ref?.digest === 'string') return [role.critic.ref.digest as Sha256];
    fail('role predecessor content is malformed');
  }

  private rolePredecessors(role: Record<string, any>): DeliberationReport[] {
    if (role.kind === 'GENERATOR') return [];
    if (role.kind === 'CRITIC' && Array.isArray(role.generators)) return role.generators.map((bound: any) => ({ ...bound.report, wave: this.waveRef }) as DeliberationReport);
    if (role.kind === 'DEEPENER' && role.critic?.report) return [{ ...role.critic.report, wave: this.waveRef } as DeliberationReport];
    fail('role predecessor projection is malformed');
  }

  private commandEvidence(command: OutboxCommand): CommandEvidence {
    if (command.modeEpoch !== 0) fail('modeEpoch is unsupported');
    return {
      commandId: command.commandId, runId: command.runId, phaseId: command.phaseId, stepId: command.stepId,
      attemptEpoch: command.attemptEpoch, authorityEpoch: command.authorityEpoch, barrierEpoch: command.barrierEpoch,
      modeEpoch: command.modeEpoch, launchToken: command.launchToken, commandDigest: command.commandDigest,
    };
  }

  private receiptAuthorityAnchor(evidence: ReceiptEvidence): Ref {
    const value = {
      schema: 'lunacy-managed-receipt-authority/v1',
      commandDigest: evidence.command.commandDigest,
      reportDigest: evidence.report.digest,
      receiptDigest: digest(evidence),
      transport: { ...evidence.transport },
      teardown: { ...evidence.teardown },
    };
    const anchorDigest = digest(value);
    return Object.freeze({ id: `managed-receipt-authority:${evidence.command.commandDigest}:${anchorDigest}`, scope: 'outbox/managed-receipt-authority', digest: anchorDigest, bytes: canonicalString(value) });
  }

  private assertConstructionIdentity(): void {
    for (const expected of this.constructionIdentity) {
      const requested = lstatSync(expected.path); const physicalPath = realpathSync(expected.path); const stat = statSync(physicalPath);
      if (physicalPath !== expected.physicalPath || requested.dev !== expected.requestedDev || requested.ino !== expected.requestedIno || requested.mode !== expected.requestedMode
        || stat.dev !== expected.dev || stat.ino !== expected.ino || stat.mode !== expected.mode) fail('host identity changed after composition');
    }
  }

  private paths(token: string): { attempt: string; authHome: string; output: string; receipt: string; reservation: string; teardown: string; transport: string } {
    const key = digest(token);
    const attempt = join(this.policy.scratchRoot, `attempt-${key}`);
    return {
      attempt,
      authHome: `${attempt}.codex-home`,
      output: join(attempt, 'report.json'),
      receipt: join(this.policy.evidenceRoot, `managed-${key}.receipt.json`),
      reservation: join(this.policy.evidenceRoot, `managed-${key}.launch`),
      teardown: join(this.policy.evidenceRoot, `managed-${key}.teardown.json`),
      transport: join(this.policy.evidenceRoot, `managed-${key}.transport.json`),
    };
  }

  private async writeProviderIntentFence(path: string, command: OutboxCommand): Promise<void> {
    const value: ProviderIntentFence = {
      schema: 'lunacy-provider-intent/v1', command: this.commandEvidence(command),
      roleDigest: command.roleView!.digest, predecessorReportDigests: [...command.predecessorReportDigests!] as Sha256[],
    };
    let handle;
    try {
      handle = await fs.open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
      await handle.writeFile(canonicalString(value), 'utf8');
      await handle.sync();
    } catch { fail('launch token is already reserved or cannot be made durable'); }
    finally { await handle?.close().catch(() => undefined); }
    let directory;
    try { directory = await fs.open(dirname(path), fsConstants.O_RDONLY); await directory.sync(); }
    catch { fail('provider-intent parent directory cannot be made durable'); }
    finally { await directory?.close().catch(() => undefined); }
  }

  private async writeTransportEvidence(paths: ReturnType<CodexDeliberationDriver['paths']>, evidence: ModelTransportEvidenceRef): Promise<void> {
    this.parseTransportEvidence(evidence);
    await fs.writeFile(paths.transport, evidence.bytes!, { flag: 'wx', mode: 0o600 });
  }

  private parseTransportEvidence(evidence: ModelTransportEvidenceRef): ModelTransportEvidence {
    if (!evidence || Object.keys(evidence).sort().join(',') !== 'bytes,digest,id,scope' || evidence.scope !== 'outbox/model-transport'
      || typeof evidence.bytes !== 'string' || !/^[0-9a-f]{64}$/.test(evidence.digest) || evidence.id !== `model-transport:${evidence.digest}`) fail('model transport evidence Ref is invalid');
    const summary = parseCanonical<ModelTransportEvidence>(evidence.bytes);
    if (canonicalString(summary) !== evidence.bytes || digest(summary) !== evidence.digest) fail('model transport evidence Ref is not content-addressed');
    return summary;
  }

  private async readTransportEvidence(paths: ReturnType<CodexDeliberationDriver['paths']>, expected?: ModelTransportEvidenceRef): Promise<ModelTransportEvidence> {
    const bytes = await fs.readFile(paths.transport, 'utf8');
    const summary = parseCanonical<ModelTransportEvidence>(bytes);
    if (canonicalString(summary) !== bytes) fail('durable model transport evidence is not canonical');
    const evidenceDigest = digest(summary);
    const actual: ModelTransportEvidenceRef = { id: `model-transport:${evidenceDigest}`, scope: 'outbox/model-transport', digest: evidenceDigest, bytes };
    if (expected && !same(actual, expected)) fail('durable model transport evidence is not byte-identical to its receipt binding');
    return summary;
  }

  private async writeTeardown(paths: ReturnType<CodexDeliberationDriver['paths']>, command: OutboxCommand, transport: ModelTransportEvidenceRef): Promise<Ref> {
    const scratchAbsent = await fs.lstat(paths.attempt).then(() => false, (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
    const authAbsent = await fs.lstat(paths.authHome).then(() => false, (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
    if (!scratchAbsent || !authAbsent) fail('scratch teardown is incomplete');
    const durableTransport = await this.readTransportEvidence(paths, transport);
    if (digest(durableTransport) !== transport.digest) fail('teardown transport binding changed');
    const evidence: TeardownEvidence = { schema: 'lunacy-codex-deliberation-teardown/v1', command: this.commandEvidence(command), roleDigest: command.roleView!.digest, predecessorReportDigests: [...command.predecessorReportDigests!], providerExited: true, processTreeExited: true, scratchRemoved: true, transportDigest: transport.digest };
    const bytes = canonicalString(evidence); const ref: Ref = { id: `teardown:${digest(evidence)}`, scope: 'outbox/teardown', digest: digest(evidence), bytes };
    await fs.writeFile(paths.teardown, bytes, { flag: 'wx', mode: 0o600 });
    return ref;
  }

  private async readReport(path: string): Promise<DeliberationReport> {
    const stat = await fs.stat(path);
    if (!stat.isFile() || stat.size < 2 || stat.size > this.policy.maxOutputBytes) fail('provider report is absent or exceeds its bound');
    const bytes = await fs.readFile(path, 'utf8');
    const report = parseCanonical<DeliberationReport>(bytes);
    if (canonicalString(report) !== bytes || report.schema !== 'lunacy-deliberation-report/v2') fail('provider report is not canonical Report/v2');
    return report;
  }

  private async removeScratch(paths: ReturnType<CodexDeliberationDriver['paths']>): Promise<void> {
    await Promise.all([fs.rm(paths.attempt, { recursive: true, force: true }), fs.rm(paths.authHome, { recursive: true, force: true })]);
  }

  private childEnvironment(cwd: string, authHome: string, transportPort: number): NodeJS.ProcessEnv {
    return { NO_COLOR: '1', HOME: cwd, CODEX_HOME: authHome, SSL_CERT_FILE: '/etc/ssl/cert.pem', HTTPS_PROXY: `http://127.0.0.1:${transportPort}` };
  }

  private validTransportEvidence(value: ModelTransportEvidence, policyDigest: string, tlsRootsDigest: string, isolationProfileDigest: string, environmentDigest: string): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== 'acceptedConnections,bytesDown,bytesUp,closed,connectTimeoutMs,destinations,environmentDigest,isolationProfileDigest,listener,maxBytes,maxConnections,policyDigest,refusedConnections,schema,tlsRootsDigest,tlsValidatedConnections,totalConnections'
      || value.schema !== 'lunacy-codex-model-transport/v1' || value.closed !== true || value.policyDigest !== policyDigest || value.tlsRootsDigest !== tlsRootsDigest
      || value.isolationProfileDigest !== isolationProfileDigest || value.environmentDigest !== environmentDigest
      || value.maxConnections !== MODEL_MAX_CONNECTIONS || value.maxBytes !== MODEL_MAX_BYTES || value.connectTimeoutMs !== MODEL_CONNECT_TIMEOUT_MS
      || !same(value.destinations, [MODEL_DESTINATION]) || !value.listener || Object.keys(value.listener).sort().join(',') !== 'host,port'
      || value.listener.host !== '127.0.0.1' || !Number.isSafeInteger(value.listener.port) || value.listener.port < 1 || value.listener.port > 65_535) return false;
    const counters = [value.acceptedConnections, value.refusedConnections, value.totalConnections, value.tlsValidatedConnections, value.bytesUp, value.bytesDown];
    return counters.every((counter) => Number.isSafeInteger(counter) && counter >= 0)
      && value.totalConnections <= MODEL_MAX_CONNECTIONS && value.acceptedConnections + value.refusedConnections <= value.totalConnections
      && value.acceptedConnections <= value.tlsValidatedConnections && value.tlsValidatedConnections <= value.totalConnections
      && value.bytesUp + value.bytesDown <= MODEL_MAX_BYTES;
  }

  private processGroupAlive(pid: number): boolean {
    try { process.kill(-pid, 0); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
  }

  private async drainProcessGroup(pid: number): Promise<void> {
    if (process.platform === 'win32') return;
    for (let index = 0; index < 40; index += 1) {
      if (!this.processGroupAlive(pid)) return;
      try { process.kill(-pid, index < 4 ? 'SIGTERM' : 'SIGKILL'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return; throw error; }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
    fail('managed provider process tree did not exit');
  }

  private run(executable: string, args: string[], roleBytes: string, cwd: string, environment: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<Error | undefined> {
    return new Promise((resolve, reject) => {
      let child!: ChildProcess;
      let settled = false;
      let cancelled = false;
      let stderr = '';
      let spawnError: Error | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        if (killTimer) clearTimeout(killTimer);
        signal?.removeEventListener('abort', abort);
        resolve(error);
      };
      const abort = (): void => {
        cancelled = true;
        try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM'); } catch { /* best effort */ }
        try { child.kill('SIGTERM'); } catch { /* best effort */ }
        killTimer = setTimeout(() => {
          try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); } catch { /* best effort */ }
          try { child.kill('SIGKILL'); } catch { /* best effort */ }
        }, 250);
      };
      try {
        child = spawn(executable, args, { cwd, env: environment, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'ignore', 'pipe'] });
      } catch (error) { finish(error as Error); return; }
      child.stderr?.on('data', (chunk: Buffer | string) => { if (stderr.length < 4096) stderr += String(chunk).slice(0, 4096 - stderr.length); });
      child.once('error', (error) => { if (!child.pid) finish(error); else spawnError = error; });
      child.once('close', (code, closeSignal) => {
        const exitError = cancelled
          ? new Error('managed deliberation launch cancelled')
          : spawnError ?? (code === 0 && closeSignal === null ? undefined : new Error(`managed deliberation provider failed (${code ?? closeSignal ?? 'unknown'}): ${stderr.trim().slice(0, 2048)}`));
        if (!child.pid) { finish(exitError); return; }
        void this.drainProcessGroup(child.pid).then(() => finish(exitError), reject);
      });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      try { child.stdin?.end(roleBytes); }
      catch { abort(); }
    });
  }
}
