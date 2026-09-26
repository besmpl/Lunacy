"""SQLite persistence for already validated customer rows."""

from contextlib import closing
from pathlib import Path
import sqlite3


def list_customers(db_path) -> list[dict]:
    """Read customers sorted by case-sensitive ID; never create a database."""
    path = Path(db_path)
    if not path.exists():
        return []
    with closing(sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)) as db:
        rows = db.execute("SELECT id, email, display_name FROM customers ORDER BY id").fetchall()
    return [dict(zip(("id", "email", "display_name"), row)) for row in rows]


def commit_customers(db_path, records) -> None:
    """Atomically upsert this validated batch, preserving all other customers."""
    with closing(sqlite3.connect(db_path)) as db:
        with db:
            db.execute("BEGIN IMMEDIATE")
            db.execute(
                "CREATE TABLE IF NOT EXISTS customers ("
                "id TEXT PRIMARY KEY, email TEXT NOT NULL, display_name TEXT NOT NULL)"
            )
            db.executemany(
                "INSERT INTO customers (id, email, display_name) VALUES (?, ?, ?) "
                "ON CONFLICT(id) DO UPDATE SET email=excluded.email, "
                "display_name=excluded.display_name",
                [(row["id"], row["email"], row["display_name"]) for row in records],
            )
