import type { OutboxCommand } from './model.js';
import type { EffectDriver } from './driver.js';
import type { DriverReceipt } from './outbox.js';
import { CodexExecSupervisor, verifyCodexHostBoundary, type CodexSupervisorOptions } from './codex-exec-supervisor.js';
import { assertRecordBinding, assertTerminalBinding, launchRecordRef, readLaunchRecord, readTerminalRecord, verifyTerminalEvidence, type TerminalRecord } from './codex-effect-records.js';
import { commandFrameDigest, validateCodexHostPolicy, type CodexCommandFrame, type CodexHostPolicy } from './codex-host-policy.js';
import { withManagedLaunchAdmission } from './release-admission.js';

export type CodexExecDriverOptions = Readonly<{
  policy: CodexHostPolicy;
  supervisor?: Omit<CodexSupervisorOptions, 'policy'>;
  supervisorFactory?: (options: CodexSupervisorOptions) => CodexExecSupervisor;
}>;

/** Private host effect driver.  It receives only the command already selected
 * and claimed by RunKernel; it cannot select work or submit a successor. */
export class CodexExecDriver implements EffectDriver {
  private readonly policy: CodexHostPolicy;
  private readonly supervisorOptions: Omit<CodexSupervisorOptions, 'policy'>;
  private readonly factory: (options: CodexSupervisorOptions) => CodexExecSupervisor;
  private readonly supervisors = new Map<string, CodexExecSupervisor>();

  constructor(options: CodexExecDriverOptions) {
    if (!options || typeof options !== 'object') throw new Error('CodexExecDriver: options are required');
    this.policy = validateCodexHostPolicy(options.policy);
    this.supervisorOptions = options.supervisor ?? {};
    this.factory = options.supervisorFactory ?? ((supervisorOptions) => new CodexExecSupervisor(supervisorOptions));
  }

  get hostPolicy(): CodexHostPolicy { return this.policy; }

  async dispatch(command: OutboxCommand, launchToken: string, signal?: AbortSignal): Promise<DriverReceipt> {
    return withManagedLaunchAdmission(this.policy.runRoot, signal, async () => {
      const frame = this.frame(command, launchToken);
      if (command.state !== 'CLAIMED') throw new Error('CodexExecDriver: dispatch requires a claimed command');
      if (this.supervisors.has(launchToken)) throw new Error('CodexExecDriver: launch token already has a supervisor');
      const supervisor = this.factory({ ...this.supervisorOptions, policy: this.policy });
      this.supervisors.set(launchToken, supervisor);
      try {
        const launch = await supervisor.start({ command: frame, policy: this.policy, signal });
        // Driver ownership ends with the in-memory supervisor, not with the
        // driver lifetime. Durable launch/terminal records remain available for
        // reconciliation after this entry is removed.
        void supervisor.wait().finally(() => {
          if (this.supervisors.get(launchToken) === supervisor) this.supervisors.delete(launchToken);
        }).catch(() => undefined);
        const ref = launchRecordRef(launch);
        return { launchToken, commandDigest: command.commandDigest, ref };
      } catch (error) {
        // Preserve the token reservation after a failed entry.  A later observe
        // can reconcile any immutable evidence; dispatch never creates a new
        // token or silently retries the child.
        if (this.supervisors.get(launchToken) === supervisor) this.supervisors.delete(launchToken);
        throw error;
      }
    });
  }

  async observe(launchToken: string, signal?: AbortSignal): Promise<DriverReceipt | undefined> {
    if (typeof launchToken !== 'string' || launchToken.length === 0) return undefined;
    if (signal?.aborted) return undefined;
    let launch;
    try { launch = await readLaunchRecord(this.policy, launchToken); } catch { return undefined; }
    if (signal?.aborted) return undefined;
    if (!launch) return undefined;
    // Observe does not infer a command digest from the caller.  The persisted
    // launch record is the exact token/digest witness; kernel reconciliation
    // compares both fields against its UNKNOWN command before ACKing.
    try {
      await verifyCodexHostBoundary(this.policy, launch, this.supervisorOptions.attestExecutable);
      const bound = assertRecordBinding(this.policy, launch, launchToken, launch.commandDigest);
      return { launchToken: bound.launchToken, commandDigest: bound.commandDigest, ref: launchRecordRef(bound) };
    } catch { return undefined; }
  }

  async terminal(launchToken: string): Promise<TerminalRecord | undefined> {
    const supervisor = this.supervisors.get(launchToken);
    if (supervisor) {
      let record: TerminalRecord | undefined;
      try { record = await supervisor.terminal(); } catch { return undefined; }
      if (record) {
        const launch = supervisor.launchRecord;
        if (!launch) return undefined;
        try { await supervisor.verifyBoundary(); assertRecordBinding(this.policy, launch, launchToken, launch.commandDigest); assertTerminalBinding(this.policy, record, launch); } catch { return undefined; }
        return verifyTerminalEvidence(this.policy, launch, record);
      }
    }
    let launch;
    let terminal;
    try { launch = await readLaunchRecord(this.policy, launchToken); terminal = await readTerminalRecord(this.policy, launchToken); } catch { return undefined; }
    if (terminal && launch) {
      // Reconciliation callers must never accept a terminal record that is not
      // bound to the exact immutable launch witness.
      try { await verifyCodexHostBoundary(this.policy, launch, this.supervisorOptions.attestExecutable); assertRecordBinding(this.policy, launch, launchToken, launch.commandDigest); } catch { return undefined; }
      try { assertTerminalBinding(this.policy, terminal, launch); } catch { return undefined; }
      return verifyTerminalEvidence(this.policy, launch, terminal);
    } else if (terminal) {
      // Terminal evidence without its immutable launch witness is not proof
      // that this host ever entered the effect boundary.
      return undefined;
    }
    return terminal;
  }

  /** Event-driven terminal wait for the private drive pump. Restarted
   * processes have no in-memory supervisor and use the immutable record path
   * via terminal(); a live owner waits on its one supervisor promise. */
  async waitTerminal(launchToken: string, signal?: AbortSignal): Promise<TerminalRecord | undefined> {
    if (signal?.aborted) return undefined;
    const supervisor = this.supervisors.get(launchToken);
    if (supervisor) {
      try {
        const terminal = await supervisor.wait();
        if (signal?.aborted) return undefined;
        const launch = supervisor.launchRecord;
        if (!launch) return undefined;
        await supervisor.verifyBoundary();
        assertRecordBinding(this.policy, launch, launchToken, launch.commandDigest);
        assertTerminalBinding(this.policy, terminal, launch);
        return verifyTerminalEvidence(this.policy, launch, terminal);
      } catch { return undefined; }
    }
    return this.terminal(launchToken);
  }

  async cancel(launchToken: string): Promise<void> {
    await this.supervisors.get(launchToken)?.cancel();
  }

  private frame(command: OutboxCommand, launchToken: string): CodexCommandFrame {
    if (launchToken !== command.launchToken) throw new Error('CodexExecDriver: launch token mismatch');
    const expectedDigest = commandFrameDigest(command);
    if (command.commandDigest !== expectedDigest) throw new Error('CodexExecDriver: command digest mismatch');
    return Object.freeze({
      commandId: command.commandId, runId: command.runId, phaseId: command.phaseId, stepId: command.stepId,
      attemptEpoch: command.attemptEpoch, authorityEpoch: command.authorityEpoch, barrierEpoch: command.barrierEpoch,
      modeEpoch: command.modeEpoch, launchToken: command.launchToken, commandDigest: command.commandDigest, planDigest: this.policy.planDigest,
    });
  }
}

export function makeCodexExecDriver(options: CodexExecDriverOptions): CodexExecDriver { return new CodexExecDriver(options); }
