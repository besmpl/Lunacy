/**
 * Small dependency-graph primitives shared by admission, durable recovery,
 * and the private Workfront read model. Keeping the terminal predicate here
 * prevents a view from drifting from reducer admission when status semantics
 * evolve.
 */

/** A dependency is terminal only when the committed step is exactly DONE. */
export function dependencyTerminal(status: string | undefined): boolean {
  return status === 'DONE';
}

/** READY and REPAIR are both executable work awaiting admission. */
export function isDispatchableStepStatus(status: string | undefined): boolean {
  return status === 'READY' || status === 'REPAIR';
}

/** Digest-relevant identifier ordering must not depend on host locale. */
export function compareStable(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/**
 * Validate the topology carried by a recovered step projection. Plan
 * declarations are validated more strictly at their own boundary; this
 * common check protects every durable-state consumer from a forged
 * duplicate/cyclic dependency graph without creating a Workfront-specific
 * validator.
 */
export function validateDependencyTopology(
  steps: Readonly<Record<string, { stepId?: unknown; dependencies?: unknown }>>,
): Record<string, number> {
  const ids = new Set(Object.keys(steps));
  const remainingDependencies = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  const depths: Record<string, number> = {};
  for (const [key, value] of Object.entries(steps)) {
    if (!value || typeof value !== 'object') throw new Error(`step ${key} is invalid`);
    if (value.stepId !== key) throw new Error(`step ${key} identity is invalid`);
    const dependencies = value.dependencies ?? [];
    if (!Array.isArray(dependencies) || dependencies.some((item) => typeof item !== 'string')) throw new Error(`step ${key} dependencies are invalid`);
    if (new Set(dependencies).size !== dependencies.length) throw new Error(`step ${key} has duplicate dependencies`);
    for (const dependency of dependencies) {
      if (!ids.has(dependency)) throw new Error(`step ${key} references missing dependency ${dependency}`);
      if (dependency === key) throw new Error(`step ${key} has a self dependency`);
      const children = dependents.get(dependency) ?? [];
      children.push(key);
      dependents.set(dependency, children);
    }
    remainingDependencies.set(key, dependencies.length);
    depths[key] = 0;
  }
  // Kahn's algorithm avoids recursive-stack failure for a valid plan declared
  // in reverse dependency order. The returned depths also let plan admission
  // reuse this single topology analysis instead of walking the graph again.
  const ready = [...ids].filter((id) => remainingDependencies.get(id) === 0);
  let cursor = 0;
  let visited = 0;
  while (cursor < ready.length) {
    const id = ready[cursor++];
    visited += 1;
    for (const dependent of dependents.get(id) ?? []) {
      depths[dependent] = Math.max(depths[dependent], depths[id] + 1);
      const remaining = (remainingDependencies.get(dependent) ?? 0) - 1;
      remainingDependencies.set(dependent, remaining);
      if (remaining === 0) ready.push(dependent);
    }
  }
  if (visited !== ids.size) {
    const cyclic = [...ids].find((id) => (remainingDependencies.get(id) ?? 0) > 0) ?? 'unknown';
    throw new Error(`cyclic dependency involving ${cyclic}`);
  }
  return depths;
}
