import { createHash } from 'node:crypto';
import type { Sha256 } from './model.js';

function normalize(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical data cannot contain non-finite numbers');
    return Object.is(value, -0) ? 0 : value;
  }
  // Canonical bytes are a JSON contract.  Coercing BigInt (or arbitrary
  // class instances) would make distinct in-memory values share one digest,
  // which is unsafe at identity/ref boundaries.  Reject those values rather
  // than silently changing their meaning.
  if (typeof value === 'bigint') throw new TypeError('canonical data cannot contain bigint values');
  if (Array.isArray(value)) {
    // Array#map preserves holes; JSON.stringify then turns a hole into null,
    // creating a digest collision between a sparse array and an explicit null.
    // Materialize every index so sparse and dense inputs cannot alias.
    const out: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) throw new TypeError('canonical data cannot contain sparse arrays');
      out.push(normalize(value[index]));
    }
    return out;
  }
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError('canonical data must contain plain objects');
    const record = value as Record<string, unknown>;
    // A null-prototype record treats the untrusted JSON key "__proto__" as a
    // normal data key instead of invoking the legacy Object.prototype setter.
    // Without this, {"__proto__": {...}} canonicalized to {} and collided in
    // event identities, refs, and CURRENT digests.
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(record).sort()) {
      const item = record[key];
      if (item === undefined) throw new TypeError(`canonical data contains undefined at ${key}`);
      out[key] = normalize(item);
    }
    return out;
  }
  throw new TypeError(`unsupported canonical value: ${typeof value}`);
}

export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(normalize(value)));
}

export function canonicalString(value: unknown): string {
  return new TextDecoder().decode(canonicalBytes(value));
}

export function digestBytes(bytes: Uint8Array): Sha256 {
  return createHash('sha256').update(bytes).digest('hex') as Sha256;
}

export function digest(value: unknown): Sha256 { return digestBytes(canonicalBytes(value)); }

export function parseCanonical<T>(bytes: Uint8Array | string): T {
  const text = typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes);
  const parsed = JSON.parse(text) as T;
  if (canonicalString(parsed) !== text) throw new TypeError('non-canonical JSON');
  return parsed;
}

/**
 * The event identity is a structured value, never a delimiter-joined string.
 * Run/phase/step/event identifiers are user supplied and may contain any
 * printable delimiter (including `|`), so a joined key would permit both
 * collisions and ambiguous prefix/suffix parsing.  Canonical JSON gives us a
 * deterministic, injective representation for the fixed identity fields.
 */
export function identityKey(input: { runId: string; phaseId: string; stepId: string; attemptEpoch: number; authorityEpoch: number; barrierEpoch: number; eventId: string; payloadDigest: string; launchToken?: string }): string {
  const value: Record<string, unknown> = {
    runId: input.runId,
    phaseId: input.phaseId,
    stepId: input.stepId,
    attemptEpoch: input.attemptEpoch,
    authorityEpoch: input.authorityEpoch,
    barrierEpoch: input.barrierEpoch,
    eventId: input.eventId,
    payloadDigest: input.payloadDigest,
  };
  if (input.launchToken !== undefined) value.launchToken = input.launchToken;
  return canonicalString(value);
}
