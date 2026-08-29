# Decisions

- Use four Luna/xhigh scouts for repository-heavy evidence gathering; reserve Sol/high for the bounded consequential final ranking.
- Binding worker route for final ranking: `workerRoute: sol-high; phaseId: p2; stepId: S5; attemptEpoch: 1`. This attempt must use exact `gpt-5.6-sol` / `high`; invalid or unavailable routing blocks with no fallback.
