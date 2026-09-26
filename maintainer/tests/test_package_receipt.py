import copy
import json
import os
import tempfile
import unittest
from pathlib import Path
from subprocess import run
import sys

from maintainer.package_receipt import ReceiptError, create_receipt, verify_receipt, write_receipt


class PackageReceiptTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.package = Path(self.temp.name) / "package"
        self.package.mkdir()
        (self.package / "README.md").write_text("hello\n", encoding="utf-8")
        (self.package / "nested").mkdir()
        (self.package / "nested" / "data.txt").write_text("world\n", encoding="utf-8")
        self.receipt_path = Path(self.temp.name) / "receipt.json"

    def tearDown(self):
        self.temp.cleanup()

    def test_deterministic_receipt_and_unproven_source_claims(self):
        before = {path: path.read_bytes() for path in self.package.rglob("*") if path.is_file()}
        first = create_receipt(self.package, "lunacy-native@test", source_base="base", source_patch="patch")
        second = create_receipt(self.package, "lunacy-native@test", source_base="base", source_patch="patch")
        self.assertEqual(first, second)
        self.assertFalse(first["sourceClaims"]["proven"])
        write_receipt(first, self.receipt_path, package_dir=self.package)
        verify_receipt(self.package, self.receipt_path)
        self.assertEqual(before, {path: path.read_bytes() for path in self.package.rglob("*") if path.is_file()})

    def test_content_tampering_is_detected(self):
        receipt = create_receipt(self.package, "lunacy-native@test")
        (self.package / "README.md").write_text("tampered\n", encoding="utf-8")
        with self.assertRaises(ReceiptError):
            verify_receipt(self.package, receipt)

    def test_added_and_deleted_files_are_detected(self):
        receipt = create_receipt(self.package, "lunacy-native@test")
        (self.package / "new.txt").write_text("new\n", encoding="utf-8")
        with self.assertRaises(ReceiptError):
            verify_receipt(self.package, receipt)
        (self.package / "new.txt").unlink()
        (self.package / "nested" / "data.txt").unlink()
        with self.assertRaises(ReceiptError):
            verify_receipt(self.package, receipt)

    def test_symlink_and_bytecode_are_rejected(self):
        target = self.package / "README.md"
        link = self.package / "link"
        try:
            link.symlink_to(target)
        except (NotImplementedError, OSError):
            self.skipTest("symlinks unavailable")
        with self.assertRaises(ReceiptError):
            create_receipt(self.package, "lunacy-native@test")
        link.unlink()
        pycache = self.package / "__pycache__"
        pycache.mkdir()
        (pycache / "x.pyc").write_bytes(b"bytecode")
        with self.assertRaises(ReceiptError):
            create_receipt(self.package, "lunacy-native@test")

    def test_receipt_does_not_accept_path_traversal(self):
        receipt = create_receipt(self.package, "lunacy-native@test")
        bad = copy.deepcopy(receipt)
        bad["files"][0]["path"] = "../outside"
        with self.assertRaises(ReceiptError):
            verify_receipt(self.package, bad)

    def test_write_refuses_output_inside_package(self):
        receipt = create_receipt(self.package, "lunacy-native@test")
        output = self.package / "receipt.json"
        with self.assertRaisesRegex(ReceiptError, "outside package directory"):
            write_receipt(receipt, output, package_dir=self.package)
        self.assertFalse(output.exists())

    def test_write_refuses_existing_file_without_overwriting(self):
        receipt = create_receipt(self.package, "lunacy-native@test")
        self.receipt_path.write_text("sentinel\n", encoding="utf-8")
        with self.assertRaisesRegex(ReceiptError, "already exists"):
            write_receipt(receipt, self.receipt_path, package_dir=self.package)
        self.assertEqual(self.receipt_path.read_text(encoding="utf-8"), "sentinel\n")

    def test_write_refuses_existing_symlink(self):
        receipt = create_receipt(self.package, "lunacy-native@test")
        target = Path(self.temp.name) / "target.json"
        target.write_text("sentinel\n", encoding="utf-8")
        try:
            self.receipt_path.symlink_to(target)
        except (NotImplementedError, OSError):
            self.skipTest("symlinks unavailable")
        with self.assertRaisesRegex(ReceiptError, "already exists"):
            write_receipt(receipt, self.receipt_path, package_dir=self.package)
        self.assertEqual(target.read_text(encoding="utf-8"), "sentinel\n")

    @unittest.skipUnless(hasattr(os, "mkfifo"), "os.mkfifo is unavailable")
    def test_special_file_is_rejected_without_opening_it(self):
        fifo = self.package / "inert-fifo"
        os.mkfifo(fifo)
        with self.assertRaisesRegex(ReceiptError, "special file"):
            create_receipt(self.package, "lunacy-native@test")

    def test_cli_refuses_package_output_with_clean_diagnostic(self):
        output = self.package / "receipt.json"
        result = run(
            [
                sys.executable,
                "-B",
                "-m",
                "maintainer.package_receipt",
                "create",
                "--package-dir",
                str(self.package),
                "--identity",
                "lunacy-native@test",
                "--output",
                str(output),
            ],
            cwd=Path(__file__).resolve().parents[2],
            text=True,
            capture_output=True,
            timeout=10,
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("receipt error:", result.stderr)
        self.assertIn("outside package directory", result.stderr)
        self.assertNotIn("Traceback", result.stderr)
        self.assertFalse(output.exists())

    def test_cli_refuses_existing_output_without_overwriting(self):
        self.receipt_path.write_text("sentinel\n", encoding="utf-8")
        result = run(
            [
                sys.executable,
                "-B",
                "-m",
                "maintainer.package_receipt",
                "create",
                "--package-dir",
                str(self.package),
                "--identity",
                "lunacy-native@test",
                "--output",
                str(self.receipt_path),
            ],
            cwd=Path(__file__).resolve().parents[2],
            text=True,
            capture_output=True,
            timeout=10,
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("receipt output already exists", result.stderr)
        self.assertNotIn("Traceback", result.stderr)
        self.assertEqual(self.receipt_path.read_text(encoding="utf-8"), "sentinel\n")


if __name__ == "__main__":
    unittest.main()
