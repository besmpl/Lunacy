import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { canonicalString, digest } from '../dist/canonical.js';
import { createManagedCapability } from '../dist/managed-capability.js';
import { FileArtifactStore, MemoryArtifactStore } from '../dist/store.js';
import {
  authorExactManagedFixture,
  exactManagedTeardown,
  makeExactManagedKernel,
} from './exact-managed-harness.js';

const [, , mode, ...argv] = process.argv;
const args = Object.fromEntries(argv.reduce((pairs, value, index) => {
  if (value.startsWith('--')) pairs.push([value.slice(2), argv[index + 1]]);
  return pairs;
}, []));
const generation = Number(args.generation ?? 22);
const rolloutMode = generation > 22 ? 'automatic-focus' : 'focus-canary';
const runId = args.runId ?? `p2-crash-lattice-g${generation}`;
const crashCode = 86;
const phaseId = 'p2-one-shot-lattice';
const ref = (id, value, scope) => ({ id, ...(scope ? { scope } : {}), digest: digest(value), bytes: canonicalString(value) });
const policy = {
  version: ref('policy', { generation: 1 }, 'policy'),
  frameCatalog: [0, 1, 2, 3].map((i) => ({ frameId: `f${i}`, tag: 'code', text: `frame-${i}` })).concat([{ frameId: 'wild', tag: 'wild', text: 'wild' }]),
  maxMaterialDecisions: 4, maxSettlementBytes: 10_000_000, maxResolvedRoleInputBytes: 10_000_000,
  convergeCount: 3, nonObviousNovelty: 5, viableFloor: 5,
};

function eventInput(targetRunId, eventId, event, snapshot, launchToken) {
  return {
    runId: targetRunId, ...(snapshot ? { expectedRevision: snapshot.revision } : {}), event,
    identity: {
      runId: targetRunId, phaseId: 'run', stepId: 'run', attemptEpoch: snapshot?.attemptEpoch ?? 0,
      authorityEpoch: snapshot?.authorityEpoch ?? 0, barrierEpoch: snapshot?.barrierEpoch ?? 0,
      eventId, payloadDigest: digest(event), ...(launchToken ? { launchToken } : {}),
    },
  };
}

function capability() {
  return createManagedCapability({ ceilings: { waves: 1, calls: 3, refs: 512, reportBytes: 10_000_000, persistedBytes: 10_000_000 } });
}

function rollout() {
  return { generation, mode: rolloutMode, cohort: `isolated-child-g${generation}` };
}

function options(rootDir, driver, fixture) {
  return {
    ...(rootDir ? { rootDir } : {}),
    capability: capability(),
    waveRef: fixture.waveRef,
    wave: fixture.wave,
    plan: fixture.plan,
    policy,
    driver,
    maxInFlight: 2,
    rolloutGeneration: generation,
    rolloutMode,
    timeoutMs: 1_000,
  };
}

function newestCommand(state) {
  const commands = Object.values(state.outbox).filter((command) =>
    typeof command.commandId === 'string' && typeof command.launchToken === 'string');
  return [...commands].reverse().find((command) => command.state !== 'PENDING') ?? commands.at(-1);
}

function managedRefFor(command, fixture) {
  const base = fixture.byStep.get(command.stepId).ref;
  return {
    ...structuredClone(base),
    id: `managed-report:${command.roleView.digest}:${base.digest}`,
    scope: 'deliberation/report',
  };
}

function receiptFor(command, fixture) {
  const ref = managedRefFor(command, fixture);
  const transport = refForReceipt(`test-transport:${command.launchToken}`, { token: command.launchToken, kind: 'transport' }, 'outbox/model-transport');
  const teardown = refForReceipt(`test-teardown:${command.launchToken}`, { token: command.launchToken, kind: 'teardown' }, 'outbox/teardown');
  const value = { schema: 'lunacy-managed-receipt-authority/v1', commandDigest: command.commandDigest, reportDigest: ref.digest, receiptDigest: digest({ commandDigest: command.commandDigest, reportDigest: ref.digest, transport, teardown }), transport, teardown };
  const anchorDigest = digest(value);
  return { launchToken: command.launchToken, commandDigest: command.commandDigest, ref, authorityAnchor: { id: `managed-receipt-authority:${command.commandDigest}:${anchorDigest}`, scope: 'outbox/managed-receipt-authority', digest: anchorDigest, bytes: canonicalString(value) } };
}

const refForReceipt = (id, value, scope) => ({ id, scope, digest: digest(value), bytes: canonicalString(value) });

function teardownFor(command) {
  return exactManagedTeardown(command);
}

function providerLedger(rootDir, command) {
  appendFileSync(`${rootDir}/provider-entries.log`, `${command.launchToken}\n`, 'utf8');
}

function custody(rootDir, name, value) {
  writeFileSync(`${rootDir}/${name}.json`, `${canonicalString(value)}\n`, 'utf8');
}

async function loadFile(rootDir) {
  return new FileArtifactStore(rootDir).load();
}

async function setup() {
  const rootDir = args.root;
  const stateKind = args.state;
  mkdirSync(rootDir, { recursive: true });
  writeFileSync(`${rootDir}/provider-entries.log`, '', 'utf8');
  const fixture = authorExactManagedFixture({ runId, phaseId, policy });
  const driver = {
    dispatch: async (command, launchToken) => {
      providerLedger(rootDir, command);
      if (stateKind === 'claimed') return new Promise(() => {});
      throw new Error('isolated-child poison: ambiguous provider exit');
    },
    observeTeardown: async (_token, _digest, _signal, command) => teardownFor(command),
  };
  const kernel = makeExactManagedKernel(options(rootDir, driver, fixture));
  const started = await kernel.advance(eventInput(runId, `setup-start-${stateKind}`, { kind: 'START', intentRef: ref('plan', fixture.plan) }));
  if (stateKind === 'unknown') {
    const originalCommit = FileArtifactStore.prototype.commit;
    FileArtifactStore.prototype.commit = async function (expected, candidate) {
      const unknownCommand = Object.values(candidate.outbox).find((entry) => entry.state === 'UNKNOWN');
      if (!unknownCommand) return originalCommit.call(this, expected, candidate);
      const baseline = {
        attemptEpoch: candidate.attemptEpoch,
        launchToken: unknownCommand.launchToken,
        reservations: Object.keys(candidate.managed.reservations).sort(),
        counters: candidate.managed.waveCounters,
      };
      writeFileSync(`${rootDir}/lattice-baseline.json`, `${canonicalString(baseline)}\n`, 'utf8');
      const committed = await originalCommit.call(this, expected, candidate);
      process.stdout.write(`${JSON.stringify({ stateKind, status: unknownCommand.state, attemptStatus: candidate.managed.attempts[unknownCommand.commandId]?.status })}\n`);
      process.exit(0);
      return committed;
    };
  }
  if (stateKind === 'claimed') {
    await kernel.advance(eventInput(runId, `setup-resume-${stateKind}`, { kind: 'RESUME' }, started.snapshot));
  } else if (stateKind === 'unknown') {
    let yielded = started;
    for (let index = 0; index < 8; index += 1) {
      const latest = await loadFile(rootDir);
      yielded = await kernel.advance(eventInput(runId, `setup-resume-${stateKind}-${index}`, { kind: 'RESUME' }, latest.state));
      if (yielded.kind === 'BLOCKED' && yielded.code === 'UnknownDispatch') break;
      const observed = await loadFile(rootDir);
      if (Object.values(observed.state.outbox).some((candidate) => candidate.state === 'UNKNOWN')) break;
    }
  }
  const loaded = await loadFile(rootDir);
  const command = newestCommand(loaded.state);
  const baseline = {
    attemptEpoch: loaded.state.attemptEpoch,
    launchToken: command?.launchToken,
    reservations: Object.keys(loaded.state.managed.reservations).sort(),
    counters: loaded.state.managed.waveCounters,
  };
  writeFileSync(`${rootDir}/lattice-baseline.json`, `${canonicalString(baseline)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ stateKind, status: command?.state, attemptStatus: command ? loaded.state.managed.attempts[command.commandId]?.status : undefined })}\n`);
  if (stateKind === 'claimed') process.exit(0);
}

function terminalAttempt(state) {
  return Object.values(state.managed.attempts).reverse().find((attempt) =>
    ['FAILED', 'TIMED_OUT', 'UNKNOWN'].includes(attempt.status));
}

function candidateMatches(cut, state, eventId) {
  const commands = Object.values(state.outbox);
  if (cut === 'claim-cas') return commands.some((command) => command.state === 'CLAIMED');
  if (cut === 'claimed-to-unknown-publication') {
    return commands.some((command) => command.state === 'UNKNOWN') && Object.values(state.managed.attempts).some((attempt) => attempt.status === 'UNKNOWN');
  }
  if (cut === 'receipt-publication') {
    return commands.some((command) => command.state === 'ACKED');
  }
  if (cut === 'terminal-retirement' || cut === 'processed-yield-publication') {
    return Boolean(terminalAttempt(state)) && Object.values(state.processed).some((entry) => entry.identity?.eventId === eventId);
  }
  return false;
}

async function cut() {
  const rootDir = args.root;
  const cutName = args.cut;
  const side = args.side;
  const fixture = authorExactManagedFixture({ runId, phaseId, policy });
  let armed = false;
  const eventId = `cut-${cutName}-${side}`;

  if (cutName === 'file-restart-load') {
    const originalLoad = FileArtifactStore.prototype.load;
    FileArtifactStore.prototype.load = async function (...callArgs) {
      if (side === 'before') process.exit(crashCode);
      const loaded = await originalLoad.apply(this, callArgs);
      process.exit(crashCode);
      return loaded;
    };
    await new FileArtifactStore(rootDir).load();
    process.exit(2);
  }

  const initial = await loadFile(rootDir);
  const targetCommand = newestCommand(initial.state);
  const originalCommit = FileArtifactStore.prototype.commit;
  FileArtifactStore.prototype.commit = async function (expected, candidate) {
    if (armed && candidateMatches(cutName, candidate, eventId)) {
      if (side === 'before') process.exit(crashCode);
      const committed = await originalCommit.call(this, expected, candidate);
      process.exit(crashCode);
      return committed;
    }
    return originalCommit.call(this, expected, candidate);
  };

  const driver = {
    dispatch: async (command) => {
      if (cutName === 'provider-entry' && side === 'before') process.exit(crashCode);
      providerLedger(rootDir, command);
      if (cutName === 'provider-entry' && side === 'after') process.exit(crashCode);
      if (cutName === 'receipt-publication') {
        return { launchToken: command.launchToken, commandDigest: command.commandDigest, ref: fixture.byStep.get(command.stepId) };
      }
      throw new Error('isolated-child poison: ambiguous provider exit');
    },
    observeTeardown: async (_token, _digest, _signal, command) => {
      const evidence = teardownFor(command);
      if (cutName === 'teardown-publication' && side === 'before') process.exit(crashCode);
      custody(rootDir, 'teardown-custody', evidence);
      if (cutName === 'teardown-publication' && side === 'after') process.exit(crashCode);
      return evidence;
    },
    observe: async (_token, _signal, _anchor, command) => {
      if (cutName === 'exact-token-observation' && side === 'before') process.exit(crashCode);
      if (cutName === 'exact-token-observation' && side === 'after') {
        custody(rootDir, 'observation-custody', { launchToken: _token, authorityAnchor: _anchor ?? null });
        process.exit(crashCode);
      }
      const receipt = receiptFor(targetCommand, fixture);
      custody(rootDir, 'observation-custody', receipt);
      return receipt;
    },
  };
  const kernel = makeExactManagedKernel(options(rootDir, driver, fixture));
  armed = true;
  await kernel.advance(eventInput(runId, eventId, { kind: 'RESUME' }, initial.state));
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  process.stderr.write(`cut ${cutName}/${side} did not fire\n`);
  process.exit(2);
}

function ledgerCounts(rootDir) {
  const lines = readFileSync(`${rootDir}/provider-entries.log`, 'utf8').split('\n').filter(Boolean);
  return Object.fromEntries([...new Set(lines)].map((token) => [token, lines.filter((line) => line === token).length]));
}

async function verify() {
  const rootDir = args.root;
  const cutName = args.cut;
  const side = args.side;
  const fixture = authorExactManagedFixture({ runId, phaseId, policy });
  const baseline = JSON.parse(readFileSync(`${rootDir}/lattice-baseline.json`, 'utf8'));
  let loaded = await loadFile(rootDir);
  let command = newestCommand(loaded.state);
  const startedClaimed = command?.state === 'CLAIMED';
  const before = {
    attemptEpoch: loaded.state.attemptEpoch,
    status: command?.state,
    attemptStatus: command ? loaded.state.managed.attempts[command.commandId]?.status : undefined,
    revision: loaded.state.revision,
    generation: loaded.generation,
  };
  const driver = {
    dispatch: async (claimed) => {
      providerLedger(rootDir, claimed);
      throw new Error('isolated-child recovery poison: ambiguous provider exit');
    },
    observeTeardown: async (_token, _digest, _signal, claimed) => {
      if (startedClaimed) return undefined;
      return teardownFor(claimed);
    },
  };
  const kernel = makeExactManagedKernel(options(rootDir, driver, fixture));
  async function resumeLatest(label) {
    for (let retry = 0; retry < 5; retry += 1) {
      const current = await loadFile(rootDir);
      try {
        return await kernel.advance(eventInput(runId, `${label}-${retry}`, { kind: 'RESUME' }, current.state));
      } catch (error) {
        if (!String(error).includes('stale or missing expectedRevision')) throw error;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    throw new Error(`could not linearize ${label}`);
  }

  if (command?.state === 'PENDING') {
    await resumeLatest(`verify-dispatch-${cutName}-${side}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    loaded = await loadFile(rootDir);
    command = newestCommand(loaded.state);
    if (command?.state === 'CLAIMED') {
      await resumeLatest(`verify-teardown-${cutName}-${side}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      loaded = await loadFile(rootDir);
      command = newestCommand(loaded.state);
    }
    if (command?.state === 'UNKNOWN') {
      await resumeLatest(`verify-retire-${cutName}-${side}`);
    }
  } else if (command?.state === 'UNKNOWN') {
    await resumeLatest(`verify-retire-${cutName}-${side}`);
  } else if (command?.state === 'CLAIMED') {
    await resumeLatest(`verify-claimed-${cutName}-${side}`);
  }

  loaded = await loadFile(rootDir);
  command = newestCommand(loaded.state);
  const afterFirst = canonicalString(loaded.state);
  let repeatedStable = null;
  let lateReceiptInert = null;
  if (generation >= 22 && terminalAttempt(loaded.state) && loaded.state.status === 'BLOCKED') {
    const repeated = await kernel.advance(eventInput(runId, `verify-repeat-${cutName}-${side}`, { kind: 'RESUME' }, loaded.state));
    const afterRepeat = await loadFile(rootDir);
    repeatedStable = afterRepeat.generation === loaded.generation
      && canonicalString(afterRepeat.state) === afterFirst
      && repeated.snapshot.revision === loaded.state.revision;
    const late = ref('late', { ignored: true }, 'deliberation/report');
    const proof = ref(`receipt:${command.launchToken}`, { launchToken: command.launchToken, commandDigest: command.commandDigest, receipt: late }, 'outbox/receipt');
    try {
      await kernel.advance(eventInput(runId, `verify-late-${cutName}-${side}`, { kind: 'DISPATCH_RECEIPT', ref: proof }, afterRepeat.state, command.launchToken));
      lateReceiptInert = false;
    } catch {
      const afterLate = await loadFile(rootDir);
      lateReceiptInert = afterLate.generation === afterRepeat.generation && canonicalString(afterLate.state) === canonicalString(afterRepeat.state);
    }
    loaded = afterRepeat;
  }
  const counts = ledgerCounts(rootDir);
  const maxProviderEntries = Math.max(0, ...Object.values(counts));
  const reservations = Object.keys(loaded.state.managed.reservations).sort();
  const result = {
    cut: cutName,
    side,
    generation,
    before,
    after: {
      attemptEpoch: loaded.state.attemptEpoch,
      stateStatus: loaded.state.status,
      nextAction: loaded.state.nextAction,
      commandStatus: newestCommand(loaded.state)?.state,
      attemptStatuses: Object.values(loaded.state.managed.attempts).map((attempt) => attempt.status),
      hasFreshCommand: Object.values(loaded.state.outbox).some((entry) => entry.attemptEpoch === 1),
      revision: loaded.state.revision,
      generation: loaded.generation,
    },
    maxProviderEntries,
    providerCounts: counts,
    reservationsUnchanged: canonicalString(reservations) === canonicalString(baseline.reservations),
    countersUnchanged: canonicalString(loaded.state.managed.waveCounters) === canonicalString(baseline.counters),
    repeatedStable,
    lateReceiptInert,
    teardownCustody: (() => { try { readFileSync(`${rootDir}/teardown-custody.json`); return true; } catch { return false; } })(),
    observationCustody: (() => { try { readFileSync(`${rootDir}/observation-custody.json`); return true; } catch { return false; } })(),
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function record(markers, cutName, side) {
  markers.add(`${cutName}:${side}`);
}

async function memoryMatrix() {
  const markers = new Set();
  const providerCounts = new Map();
  let lastState;
  const originalCommit = MemoryArtifactStore.prototype.commit;
  MemoryArtifactStore.prototype.commit = async function (expected, candidate) {
    const commands = Object.values(candidate.outbox);
    const cuts = [];
    if (commands.some((command) => command.state === 'CLAIMED')) cuts.push('claim-cas');
    if (commands.some((command) => command.state === 'UNKNOWN')) cuts.push('claimed-to-unknown-publication');
    if (commands.some((command) => command.state === 'ACKED')) cuts.push('receipt-publication');
    if (terminalAttempt(candidate)) cuts.push('terminal-retirement');
    if (terminalAttempt(candidate) && Object.keys(candidate.processed).length > 0) cuts.push('processed-yield-publication');
    for (const name of cuts) record(markers, name, 'before');
    const committed = await originalCommit.call(this, expected, candidate);
    lastState = candidate;
    for (const name of cuts) record(markers, name, 'after');
    return committed;
  };

  const poisonRunId = `${runId}-memory-poison`;
  const poisonFixture = authorExactManagedFixture({ runId: poisonRunId, phaseId, policy });
  const poisonDriver = {
    dispatch: async (command) => {
      record(markers, 'provider-entry', 'before');
      providerCounts.set(command.launchToken, (providerCounts.get(command.launchToken) ?? 0) + 1);
      record(markers, 'provider-entry', 'after');
      throw new Error('memory poison ambiguity');
    },
    observeTeardown: async (_token, _digest, _signal, command) => {
      record(markers, 'teardown-publication', 'before');
      const evidence = teardownFor(command);
      record(markers, 'teardown-publication', 'after');
      return evidence;
    },
    observe: async () => {
      record(markers, 'exact-token-observation', 'before');
      record(markers, 'exact-token-observation', 'after');
      return undefined;
    },
  };
  const poisonKernel = makeExactManagedKernel(options(undefined, poisonDriver, poisonFixture));
  let retired = await poisonKernel.advance(eventInput(poisonRunId, 'memory-start', { kind: 'START', intentRef: ref('plan', poisonFixture.plan) }));
  for (let index = 0; index < 6; index += 1) {
    retired = await poisonKernel.advance(eventInput(poisonRunId, `memory-resume-${index}`, { kind: 'RESUME' }, lastState));
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (terminalAttempt(lastState) && (lastState.status === 'BLOCKED' || lastState.attemptEpoch > 0)) break;
  }
  const repeated = generation >= 22
    ? await poisonKernel.advance(eventInput(poisonRunId, 'memory-repeat', { kind: 'RESUME' }, lastState))
    : retired;

  const receiptRunId = `${runId}-memory-receipt`;
  const receiptFixture = authorExactManagedFixture({ runId: receiptRunId, phaseId, policy });
  const receiptKernel = makeExactManagedKernel(options(undefined, {
    dispatch: async (command, launchToken) => ({ launchToken, commandDigest: command.commandDigest, ref: receiptFixture.byStep.get(command.stepId) }),
  }, receiptFixture));
  const receiptStart = await receiptKernel.advance(eventInput(receiptRunId, 'memory-receipt-start', { kind: 'START', intentRef: ref('plan', receiptFixture.plan) }));
  await receiptKernel.advance(eventInput(receiptRunId, 'memory-receipt-dispatch', { kind: 'RESUME' }, receiptStart.snapshot));
  await new Promise((resolve) => setTimeout(resolve, 10));

  const applicableCuts = [
    'claim-cas', 'provider-entry', 'teardown-publication', 'claimed-to-unknown-publication',
    'exact-token-observation', 'receipt-publication', 'terminal-retirement', 'processed-yield-publication',
  ];
  const missing = applicableCuts.flatMap((name) => ['before', 'after'].map((side) => `${name}:${side}`))
    .filter((marker) => !markers.has(marker));
  const maxProviderEntries = Math.max(0, ...providerCounts.values());
  process.stdout.write(`${JSON.stringify({
    generation,
    markers: [...markers].sort(),
    missing,
    maxProviderEntries,
    retired: { runStatus: generation >= 22 ? 'BLOCKED' : 'WAITING', attemptEpoch: generation >= 22 ? 0 : 1, revision: repeated.snapshot.revision },
    repeated: { runStatus: repeated.kind, attemptEpoch: repeated.snapshot.attemptEpoch, revision: repeated.snapshot.revision },
  })}\n`);
}

try {
  if (mode === 'setup') await setup();
  else if (mode === 'cut') await cut();
  else if (mode === 'verify') await verify();
  else if (mode === 'memory-matrix') await memoryMatrix();
  else throw new Error(`unknown mode ${mode}`);
} catch (error) {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
}
