# Coupled case: cancellation invariant

This is a synthetic planning snapshot, not a command to run. The adopted outcome is one fix: once a job is canceled, a late completion must never make it completed. No assignments or ready labels are supplied.

Source snapshot: `jobs/state.py` and `tests/test_state.py` form one changing state-transition contract. The test must be written against the chosen transition semantics, and the implementation may adjust that semantics during repair. A second writer cannot safely own either file while the first owner is changing the contract. There are no independent user-visible criteria or separately consumable results. The final parent check should run the cancellation-before-completion counterexample and inspect the exact diff.

Task: decide whether more than one delivery owner is useful, and state the safe work/proof. Do not make an idle slot a reason to split code and test.
