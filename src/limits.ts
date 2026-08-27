/**
 * The journal remains a finite append-only prefix until a separately designed
 * compaction/segment protocol is authorized.  Keep the limits in one private
 * module so reducer/store/public checks cannot drift.
 */
export const JOURNAL_EVENT_CEILING = 10_000;
export const JOURNAL_BYTE_CEILING = 1_048_576;

/** Read-only managed inspection rejects corrupt/sparse durable files before
 * allocation. These are inspection ceilings, not permission for writers to
 * grow authoritative state without their existing semantic limits. */
export const CURRENT_BYTE_CEILING = 65_536;
export const READ_ONLY_STATE_BYTE_CEILING = 16_777_216;
export const MANAGED_METADATA_BYTE_CEILING = 1_048_576;
