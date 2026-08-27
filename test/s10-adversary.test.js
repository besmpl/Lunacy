import test from 'node:test';
import assert from 'node:assert/strict';
import { deleteBridge, disable, BridgeError } from '../dist/bridge.js';

test('private disable/delete reject an implicit or markdown mode', async () => {
  for (const operation of [disable, deleteBridge]) {
    await assert.rejects(
      () => operation({ runDir: '/tmp/s10-mode-boundary', runId: 's10', mode: 'markdown' }),
      (error) => error instanceof BridgeError && error.code === 'ModeConflict',
    );
    await assert.rejects(
      () => operation({ runDir: '/tmp/s10-mode-boundary', runId: 's10' }),
      (error) => error instanceof BridgeError && error.code === 'ModeConflict',
    );
  }
});
