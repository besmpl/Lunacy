import unittest

from contact import normalize_email


class ContactTests(unittest.TestCase):
    def test_lowercases_domain_and_preserves_local_case(self):
        self.assertEqual(normalize_email("Alice@EXAMPLE.COM"),
                         "Alice@example.com")


if __name__ == "__main__":
    unittest.main()
