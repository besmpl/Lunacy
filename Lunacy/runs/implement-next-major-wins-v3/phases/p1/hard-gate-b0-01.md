# P1 B0 hard gate 01 — comparison authorities

Status: **PASS**

- Authoritative replacement is `evidence/b0-v2/`; the original S1 evidence is historical and rejected solely for unnecessary per-file hash catalogs.
- B0-v2 preserves one aggregate dirty-baseline fingerprint, exact canonical comparison records, deterministic command summaries/logs, environment, fault schedules, and accepted release-envelope behavior without a hash catalog.
- Deterministic authorities are green: inbox 6/6, lifecycle/effects 34/34, legacy/v1/v2 43/43, release envelope 7/7. The replacement self-check validates 24 canonical records, replay equality, release path digests, 33 ordinary references, and zero catalog keys.
- Parent checked the replacement manifest, no-hash-catalog condition, and owned-artifact formatting.
- B0 is comparison-only and makes no performance, token, provider, security, production, release, install, or product-value claim.

P1-A product writing is authorized within S2 only.
