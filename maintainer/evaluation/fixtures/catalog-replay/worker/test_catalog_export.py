import json
from pathlib import Path
import tempfile
import unittest

from catalog_export import export_catalog


class CatalogExportSmokeTest(unittest.TestCase):
    def test_single_ascii_item(self):
        archive = {"first": "root", "pages": {"root": {
            "rows": [{"sku": "a", "revision": 1, "active": True,
                      "name": "Desk"}], "next": None}}}
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "capture.json"
            destination = root / "catalog.csv"
            source.write_text(json.dumps(archive), encoding="utf-8")
            export_catalog(source, destination)
            self.assertEqual(destination.read_bytes(),
                             b"sku,revision,name\na,1,Desk\n")


if __name__ == "__main__":
    unittest.main()
