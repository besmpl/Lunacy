# Counterexample: disjoint paths, shared effect

This is a synthetic planning snapshot, not a command to run. The adopted outcome is to update a Python client and a JavaScript client for protocol revision 5. No assignments or ready labels are supplied.

Source snapshot: `clients/python.py` and `clients/js.ts` are disjoint, but each client generator rewrites the same `generated/protocol.lock` and `generated/schema/` directory. The generator is not isolated and cannot be made read-only for this task. The revision-5 protocol specification is settled. Individual client tests can run in separate immutable copies only after generation is resolved; final integration must check both clients against one generated revision.

Task: identify valuable results and a safe ownership/ordering scheme. Do not call two source-path owners independent if their generation effects collide.
