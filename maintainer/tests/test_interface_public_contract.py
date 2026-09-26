"""Worker-only interface documentation must expose evaluator-required fields."""
from pathlib import Path
import tempfile
import unittest

from maintainer import evaluation_pack


class InterfacePublicContractTests(unittest.TestCase):
    def test_materialized_packet_names_receipt_interface_and_hash_fields(self):
        with tempfile.TemporaryDirectory() as temporary:
            candidate = evaluation_pack.materialize(
                "interface-integration", Path(temporary) / "candidate")
            public_task = (candidate / "TASK.md").read_text(encoding="utf-8")
            for required in (
                "classify_integration_receipt", "catalogSha256", "invoiceSha256",
                "exitCode", "SHA-256",
            ):
                with self.subTest(required=required):
                    self.assertIn(required, public_task)
            self.assertFalse((candidate / "evaluator").exists())


if __name__ == "__main__":
    unittest.main()
