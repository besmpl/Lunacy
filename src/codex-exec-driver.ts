import type { OutboxCommand } from './model.js';
import type { EffectDriver } from './driver.js';
import type { DriverReceipt } from './outbox.js';
import { CodexExecSupervisor, type CodexSupervisorOptions } from './codex-exec-supervisor.js';
import { effectPaths, launchRecordRef, readBoundedUtf8File, readLaunchIntentRecord, readLaunchRecord, readTerminalRecord, validateHistoricalCodexEffect, type HistoricalCodexEffectFacts, type TerminalRecord } from './codex-effect-records.js';
import { commandFrameDigest, expectedReportPath, validateCodexHostPolicy, type CodexCommandFrame, type CodexHostPolicy } from './codex-host-policy.js';
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
  private readonly commands = new Map<string, OutboxCommand>();

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
        this.commands.set(launchToken, JSON.parse(JSON.stringify(command)) as OutboxCommand);
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

  async observe(launchToken: string, signal?: AbortSignal, _authorityAnchor?: import('./model.js').Ref, retainedCommand?: OutboxCommand): Promise<DriverReceipt | undefined> {
    if (typeof launchToken !== 'string' || launchToken.length === 0) return undefined;
    if (signal?.aborted) return undefined;
    const command = this.retainedCommand(launchToken, retainedCommand);
    if (!command) return undefined;
    const evidence = await this.validateEvidence(command, 'launch');
    if (signal?.aborted) return undefined;
    if (!evidence) return undefined;
    return { launchToken, commandDigest: command.commandDigest, ref: evidence.launchRef };
  }

  async terminal(launchToken: string, _signal?: AbortSignal, retainedCommand?: OutboxCommand): Promise<TerminalRecord | undefined> {
    const command = this.retainedCommand(launchToken, retainedCommand);
    if (!command) return undefined;
    const supervisor = this.supervisors.get(launchToken);
    if (supervisor) {
      try { await supervisor.terminal(); } catch { return undefined; }
    }
    return (await this.validateEvidence(command, 'terminal'))?.terminalRecord;
  }

  /** Event-driven terminal wait for the private drive pump. Restarted
   * processes have no in-memory supervisor and use the immutable record path
   * via terminal(); a live owner waits on its one supervisor promise. */
  async waitTerminal(launchToken: string, signal?: AbortSignal, retainedCommand?: OutboxCommand): Promise<TerminalRecord | undefined> {
    if (signal?.aborted) return undefined;
    const command = this.retainedCommand(launchToken, retainedCommand);
    if (!command) return undefined;
    const supervisor = this.supervisors.get(launchToken);
    if (supervisor) {
      try {
        await supervisor.wait();
        if (signal?.aborted) return undefined;
        return (await this.validateEvidence(command, 'terminal'))?.terminalRecord;
      } catch { return undefined; }
    }
    return this.terminal(launchToken, signal, command);
  }

  async cancel(launchToken: string): Promise<void> {
    await this.supervisors.get(launchToken)?.cancel();
  }

  private frame(command: OutboxCommand, launchToken: string): CodexCommandFrame {
    if (launchToken !== command.launchToken) throw new Error('CodexExecDriver: launch token mismatch');
    if (command.modeEpoch !== 0) throw new Error('CodexExecDriver: modeEpoch is unsupported');
    const expectedDigest = commandFrameDigest(command);
    if (command.commandDigest !== expectedDigest) throw new Error('CodexExecDriver: command digest mismatch');
    return Object.freeze({
      commandId: command.commandId, runId: command.runId, phaseId: command.phaseId, stepId: command.stepId,
      attemptEpoch: command.attemptEpoch, authorityEpoch: command.authorityEpoch, barrierEpoch: command.barrierEpoch,
      modeEpoch: command.modeEpoch, launchToken: command.launchToken, commandDigest: command.commandDigest, planDigest: this.policy.planDigest,
    });
  }

  private retainedCommand(launchToken: string, retained?: OutboxCommand): OutboxCommand | undefined {
    const command = retained ?? this.commands.get(launchToken);
    if (!command || command.launchToken !== launchToken || command.modeEpoch !== 0) return undefined;
    try { this.frame(command, launchToken); }
    catch { return undefined; }
    return JSON.parse(JSON.stringify(command)) as OutboxCommand;
  }

  private async validateEvidence(command: OutboxCommand, requiredStage: 'launch' | 'terminal'): Promise<HistoricalCodexEffectFacts | undefined> {
    try {
      const intent = await readLaunchIntentRecord(this.policy, command.launchToken);
      const launch = await readLaunchRecord(this.policy, command.launchToken);
      if (!intent || !launch) return undefined;
      if (requiredStage === 'launch') return validateHistoricalCodexEffect({ command, runRoot: this.policy.runRoot, requiredStage, intent, launch });
      const terminal = await readTerminalRecord(this.policy, command.launchToken);
      if (!terminal) return undefined;
      const paths = effectPaths(this.policy, command.launchToken);
      const output = await readBoundedUtf8File(paths.output, 'Codex final output', this.policy.maxOutputBytes);
      const report = terminal.outcome === 'normal-completion'
        ? await readBoundedUtf8File(expectedReportPath(this.policy, command), 'worker report', this.policy.maxReportBytes)
        : undefined;
      return validateHistoricalCodexEffect({ command, runRoot: this.policy.runRoot, requiredStage, intent, launch, terminal, output, report });
    } catch { return undefined; }
  }
}

export function makeCodexExecDriver(options: CodexExecDriverOptions): CodexExecDriver { return new CodexExecDriver(options); }
