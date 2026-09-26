"""Transparent single-line success smoke checks, NOT full acceptance."""

import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from core.store import list_customers
from http_api import application


ROOT = Path(__file__).resolve().parent
EXPECTED = {
    "json": {"id": "acct-010", "email": "ada@example.com", "display_name": "Ada Lovelace"},
    "csv": {"id": "acct-011", "email": "grace@example.com", "display_name": "Grace Hopper"},
}


class SingleLineSuccessSmoke(unittest.TestCase):
    def test_actual_cli(self):
        for format, row in EXPECTED.items():
            with self.subTest(format=format), tempfile.TemporaryDirectory(dir=ROOT) as scratch:
                db = Path(scratch) / "customers.sqlite"
                run = subprocess.run([
                    sys.executable, "-B", str(ROOT / "cli.py"), "--database", str(db),
                    "--format", format, "--input", str(ROOT / "inputs" / ("initial." + format)),
                ], capture_output=True, timeout=2, check=False)
                self.assertEqual(run.returncode, 0, run.stderr.decode("utf-8", errors="replace"))
                self.assertEqual(json.loads(run.stdout), {"status": "ok", "imported": 1})
                self.assertTrue(run.stdout.endswith(b"\n"))
                self.assertEqual(len(run.stdout.splitlines()), 1)
                self.assertEqual(list_customers(db), [row])

    def test_actual_wsgi(self):
        for format, row in EXPECTED.items():
            with self.subTest(format=format), tempfile.TemporaryDirectory(dir=ROOT) as scratch:
                db = Path(scratch) / "customers.sqlite"
                payload = (ROOT / "inputs" / ("initial." + format)).read_bytes()
                response = []
                body = application({
                    "REQUEST_METHOD": "POST", "PATH_INFO": "/imports",
                    "CONTENT_TYPE": "application/json" if format == "json" else "text/csv",
                    "CONTENT_LENGTH": str(len(payload)), "wsgi.input": io.BytesIO(payload),
                    "lunacy.database": db,
                }, lambda status, headers: response.append((status, dict(headers))))
                self.assertEqual(response[0][0], "200 OK")
                self.assertIsInstance(body, list)
                self.assertEqual(len(body), 1)
                self.assertEqual(json.loads(body[0]), {"status": "ok", "imported": 1})
                self.assertTrue(body[0].endswith(b"\n"))
                self.assertEqual(response[0][1], {
                    "Content-Type": "application/json", "Content-Length": str(len(body[0])),
                })
                self.assertEqual(list_customers(db), [row])


if __name__ == "__main__":
    unittest.main()
