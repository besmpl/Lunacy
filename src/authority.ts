import { digest } from './canonical.js';
import type { MachineState, Sha256 } from './model.js';

export type AuthorityReadSet = { plan: unknown; notes?: unknown; declarations?: unknown; decisions?: unknown };
export function authorityDigest(reads: AuthorityReadSet): Sha256 { return digest(reads); }
export function verifyAuthority(state: MachineState, reads: AuthorityReadSet): boolean { return state.planDigest === digest(reads.plan); }
export function verifyReadSet(expected: Sha256, value: unknown): boolean { return expected === digest(value); }
