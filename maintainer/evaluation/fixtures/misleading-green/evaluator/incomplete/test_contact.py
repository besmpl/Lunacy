import unittest

from contact import normalize_email


class ContactTests(unittest.TestCase):
    def test_lowercases_domain_and_preserves_local_case(self):
        self.assertEqual(normalize_email("Alice@EXAMPLE.COM"),
                         "Alice@example.com")

    def test_already_lowercase_domain(self):
        self.assertEqual(normalize_email("Bob@example.com"),
                         "Bob@example.com")


if __name__ == "__main__":
    unittest.main()
