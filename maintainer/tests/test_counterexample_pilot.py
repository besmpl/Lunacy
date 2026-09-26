import unittest


BASELINE = """
def final_state(events):
    state = 'running'
    for event in events:
        if event == 'cancel':
            state = 'cancelled'
        elif event == 'complete' and state != 'cancelled':
            state = 'completed'
    return state
"""

SEMANTIC_MUTANT = """
def final_state(events):
    state = 'running'
    for event in events:
        if event == 'cancel':
            state = 'cancelled'
        elif event == 'complete':
            state = 'completed'
    return state
"""

SYNTAX_INVALID_MUTANT = "def final_state(events):\n    return ("


def load(source):
    namespace = {}
    exec(compile(source, "<pilot>", "exec"), namespace)
    return namespace["final_state"]


class CounterexamplePilotTests(unittest.TestCase):
    def test_correct_implementation_passes_lifecycle_counterexample(self):
        self.assertEqual(load(BASELINE)(["cancel", "complete"]), "cancelled")

    def test_semantic_mutant_fails_discriminating_assertion(self):
        with self.assertRaises(AssertionError):
            self.assertEqual(load(SEMANTIC_MUTANT)(["cancel", "complete"]), "cancelled")

    def test_weak_test_survives_semantic_mutant(self):
        weak_events = ["complete"]
        self.assertEqual(load(BASELINE)(weak_events), "completed")
        self.assertEqual(load(SEMANTIC_MUTANT)(weak_events), "completed")

    def test_syntax_invalid_mutant_is_reported_separately(self):
        with self.assertRaises(SyntaxError):
            load(SYNTAX_INVALID_MUTANT)


if __name__ == "__main__":
    unittest.main()
