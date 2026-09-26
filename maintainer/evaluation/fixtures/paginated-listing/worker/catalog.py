from dataclasses import dataclass


@dataclass(frozen=True)
class Page:
    names: tuple
    next_cursor: str | None


def fetch_page(names, cursor=None, limit=2):
    if limit <= 0:
        raise ValueError("limit must be positive")
    start = int(cursor) if cursor is not None else 0
    end = min(start + limit, len(names))
    next_cursor = str(end) if end < len(names) else None
    return Page(tuple(names[start:end]), next_cursor)
