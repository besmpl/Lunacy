# S1R1 Worker Report
## Control
Status: PASS
Goal/result: Removed the remaining permissive README wording so every changed operator/product surface states the persistent typed-AUTO default consistently.
Changed: `README.md` operator overview; `test/p4-operator-docs.test.js` regression guard against permissive installed-profile wording.
Verification: `npm run check` PASS (716 tests: 712 pass, 4 skip; typecheck/build/pack PASS); skill quick-validation PASS; disposable deploy/check PASS (`current`, 220 managed files).
Self-review/fixes: Audited only changed operator/product/deployed-guide surfaces; retained fail-safe-disabled wording exclusively for package/runtime absence and found no equivalent installed-profile “may select” claim.
Principle/contract impact: NONE beyond making the accepted operator-profile default unambiguous; Direct, explicit Explore, one-shot/no-reentry, and absent-composition refusal remain unchanged.
Decision needed: NO
Risk/blocker: NONE

## Detail
- The README overview now distinguishes the installed operator profile’s persistent AUTO default from the package/runtime’s intentionally absent ambient rollout.
- Focused assertions reject a future return to “installed operator profile may select … automatic-focus”.
- No production install, commit, push, dependency install, or run-control edit was performed.
