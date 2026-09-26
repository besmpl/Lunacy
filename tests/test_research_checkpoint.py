"""Independent contract checks for the advisory research checkpoint projector."""

from __future__ import annotations

from contextlib import redirect_stderr, redirect_stdout
from copy import deepcopy
import importlib.util
import io
import itertools
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "research_checkpoint.py"
SPEC = importlib.util.spec_from_file_location("research_checkpoint", SCRIPT)
checkpoint = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(checkpoint)

SCHEMA = "lunacy-research-checkpoint-v1"
VIEW_SCHEMA = "lunacy-research-checkpoint-view-v1"
BASIS = "question-and-inputs-v1"
MAX_BYTES = 1024 * 1024
CANARY = "private-receipt-source-canary-76219"


def observation(identifier="e1", branch="alpha", basis=BASIS,
                relation="supports", origin="raw-origin", receipt="receipt:e1"):
    return {"id": identifier, "branch": branch, "basis_revision": basis,
            "relation": relation, "origin": origin, "receipt": receipt}


def declared_check(identifier="c1", branch="alpha", basis=BASIS,
                   evidence_ids=("e1",), result="passed", receipt="receipt:c1"):
    return {"id": identifier, "branch": branch, "basis_revision": basis,
            "evidence_ids": list(evidence_ids), "result": result, "receipt": receipt}


def snapshot(branches=("alpha",), evidence=(), checks=(), basis=BASIS):
    return {"schema": SCHEMA, "basis_revision": basis, "branches": list(branches),
            "evidence": list(evidence), "checks": list(checks)}


def populated_snapshot():
    return snapshot(evidence=[observation()], checks=[declared_check()])


def at_path(value, path):
    for key in path:
        value = value[key]
    return value


def changed(value, path, replacement):
    result = deepcopy(value)
    at_path(result, path[:-1])[path[-1]] = replacement
    return result


def mutable_ids(value):
    """Collect containers, not immutable string identities, for alias checks."""
    if isinstance(value, dict):
        return {id(value)} | set().union(*(mutable_ids(v) for v in value.values()))
    if isinstance(value, list):
        return {id(value)} | set().union(*(mutable_ids(v) for v in value))
    return set()


class ResearchCheckpointProjectionTests(unittest.TestCase):
    def branch(self, view, identifier="alpha"):
        return next(row for row in view["branches"] if row["id"] == identifier)

    def assert_gaps(self, branch, *expected):
        self.assertIs(type(branch["gaps"]), list)
        self.assertCountEqual(branch["gaps"], expected)

    def test_empty_evidence_is_a_gap_not_support_or_acceptance(self):
        view = checkpoint.project(snapshot())
        self.assertEqual(set(view), {
            "schema", "basis_revision", "advisory_only", "branches",
            "shared_origin_groups", "non_claims",
        })
        self.assertEqual(view["schema"], VIEW_SCHEMA)
        self.assertEqual(view["basis_revision"], BASIS)
        self.assertIs(view["advisory_only"], True)
        self.assertEqual(view["shared_origin_groups"], [])
        self.assertEqual(len(view["branches"]), 1)
        branch = self.branch(view)
        self.assertEqual(set(branch), {
            "id", "applicable_evidence_ids", "stale_evidence_ids", "supports",
            "challenges", "inconclusive", "mixed_evidence",
            "current_declared_checks", "stale_check_ids", "gaps",
        })
        self.assertEqual(branch["id"], "alpha")
        for key in ("applicable_evidence_ids", "stale_evidence_ids", "supports",
                    "challenges", "inconclusive", "current_declared_checks",
                    "stale_check_ids"):
            self.assertEqual(branch[key], [], key)
        self.assertIs(branch["mixed_evidence"], False)
        self.assert_gaps(branch, "no-applicable-evidence", "no-current-declared-check")
        self.assertIs(type(view["non_claims"]), list)
        self.assertTrue(view["non_claims"])
        self.assertTrue(all(type(value) is str and value for value in view["non_claims"]))
        # Contract concepts, not the production author's exact prose.
        nonclaims = " ".join(view["non_claims"]).lower()
        for concept in ("caller", "truth", "independen", "authorit", "accept",
                        "execut", "custody"):
            self.assertIn(concept, nonclaims)

    def test_nonclaims_state_history_and_identity_immutability_limits(self):
        nonclaims = [text.lower() for text in checkpoint.project(snapshot())["non_claims"]]
        # This checks the disclosed ceiling, not impossible historical change
        # detection from one stateless input or an exact prose formulation.
        for label, marker, concepts in (
            ("hidden-history-comparison", "histor", ("compar", "version")),
            ("identity-immutability", "immutab", ("evidence", "check", "id", "receipt")),
        ):
            with self.subTest(caveat=label):
                caveat = " ".join(text for text in nonclaims if marker in text)
                self.assertTrue(caveat, f"missing {label} non-claim")
                self.assertRegex(caveat, r"\b(?:cannot|can't|does not|not)\b")
                for concept in concepts:
                    self.assertIn(concept, caveat)

    def test_hand_worked_projection_preserves_negative_and_mixed_evidence(self):
        data = snapshot(
            branches=["zeta", "alpha"],
            evidence=[
                observation("old", basis="old-basis", origin="copied"),
                observation("z-support", "zeta", origin="copied"),
                observation("support", origin="copied"),
                observation("unclear", relation="inconclusive", origin="solo"),
                observation("negative", relation="challenges", origin="copied"),
            ],
            checks=[
                declared_check("z-check", "zeta", evidence_ids=["z-support"]),
                declared_check("unavailable", evidence_ids=["unclear", "negative", "support"],
                               result="unavailable", receipt="receipt:unavailable"),
                declared_check("failed", evidence_ids=["support", "negative", "unclear"],
                               result="failed", receipt="receipt:failed"),
                declared_check("partial", evidence_ids=["support"]),
                declared_check("old-check", basis="old-basis",
                               evidence_ids=["support", "negative", "unclear"]),
            ],
        )
        view = checkpoint.project(data)
        self.assertEqual([b["id"] for b in view["branches"]], ["alpha", "zeta"])
        alpha = self.branch(view)
        self.assertEqual(alpha["applicable_evidence_ids"], ["negative", "support", "unclear"])
        self.assertEqual(alpha["stale_evidence_ids"], ["old"])
        self.assertEqual(alpha["supports"], ["support"])
        self.assertEqual(alpha["challenges"], ["negative"])
        self.assertEqual(alpha["inconclusive"], ["unclear"])
        self.assertIs(alpha["mixed_evidence"], True)
        self.assertEqual(alpha["current_declared_checks"], [
            {"id": "failed", "result": "failed", "receipt": "receipt:failed"},
            {"id": "unavailable", "result": "unavailable", "receipt": "receipt:unavailable"},
        ])
        self.assertEqual(alpha["stale_check_ids"], ["old-check", "partial"])
        self.assert_gaps(alpha, "declared-check-failed", "declared-check-unavailable")
        zeta = self.branch(view, "zeta")
        self.assertEqual(zeta["applicable_evidence_ids"], ["z-support"])
        self.assertEqual(zeta["current_declared_checks"], [
            {"id": "z-check", "result": "passed", "receipt": "receipt:c1"},
        ])
        self.assertIs(zeta["mixed_evidence"], False)
        self.assert_gaps(zeta)
        self.assertEqual(view["shared_origin_groups"], [
            {"origin": "copied", "evidence_ids": ["negative", "old", "support", "z-support"]},
        ])

    def test_relation_matrix_does_not_turn_negative_or_inconclusive_into_support(self):
        cases = [
            ("support-only", ["supports"], False),
            ("challenge-only", ["challenges"], False),
            ("inconclusive-only", ["inconclusive"], False),
            ("support-inconclusive", ["supports", "inconclusive"], False),
            ("challenge-inconclusive", ["challenges", "inconclusive"], False),
            ("mixed", ["supports", "challenges"], True),
            ("mixed-with-inconclusive", ["inconclusive", "challenges", "supports"], True),
        ]
        for label, relations, mixed in cases:
            with self.subTest(case=label):
                evidence = [observation(relation, relation=relation) for relation in relations]
                branch = self.branch(checkpoint.project(snapshot(evidence=evidence)))
                for relation in ("supports", "challenges", "inconclusive"):
                    self.assertEqual(branch[relation], [relation] if relation in relations else [])
                self.assertIs(branch["mixed_evidence"], mixed)
                self.assert_gaps(branch, "no-current-declared-check")

    def test_check_currency_requires_exact_full_applicable_set_and_basis(self):
        evidence = [observation("a"), observation("b"), observation("old", basis="past")]
        cases = [
            ("exact-order", BASIS, ["a", "b"], True),
            ("exact-reversed", BASIS, ["b", "a"], True),
            ("subset", BASIS, ["a"], False),
            ("empty-subset", BASIS, [], False),
            ("includes-stale", BASIS, ["a", "b", "old"], False),
            ("stale-only", BASIS, ["old"], False),
            ("wrong-basis", "past", ["a", "b"], False),
        ]
        for label, basis, ids, current in cases:
            with self.subTest(case=label):
                check = declared_check("check", basis=basis, evidence_ids=ids)
                branch = self.branch(checkpoint.project(snapshot(evidence=evidence, checks=[check])))
                self.assertEqual(branch["current_declared_checks"],
                                 [{"id": "check", "result": "passed", "receipt": "receipt:c1"}]
                                 if current else [])
                self.assertEqual(branch["stale_check_ids"], [] if current else ["check"])
                self.assert_gaps(branch, *([] if current else ["no-current-declared-check"]))

    def test_empty_set_check_can_be_current_without_evidence_or_support(self):
        for evidence in ([], [observation(basis="past")]):
            for result in ("passed", "failed", "unavailable"):
                with self.subTest(stale_evidence=bool(evidence), result=result):
                    check = declared_check(evidence_ids=[], result=result)
                    branch = self.branch(checkpoint.project(snapshot(evidence=evidence, checks=[check])))
                    self.assertEqual(branch["current_declared_checks"], [
                        {"id": "c1", "result": result, "receipt": "receipt:c1"},
                    ])
                    self.assertEqual(branch["supports"], [])
                    gaps = ["no-applicable-evidence"]
                    if result != "passed":
                        gaps.append("declared-check-" + result)
                    self.assert_gaps(branch, *gaps)

    def test_failed_or_unavailable_stale_checks_do_not_create_current_failure_gaps(self):
        for result in ("failed", "unavailable"):
            with self.subTest(result=result):
                stale = declared_check("stale", basis="old", result=result)
                current = declared_check("current")
                branch = self.branch(checkpoint.project(snapshot(
                    evidence=[observation()], checks=[stale, current])))
                self.assertEqual(branch["stale_check_ids"], ["stale"])
                self.assert_gaps(branch)

    def test_new_evidence_invalidates_only_checks_of_the_affected_branch(self):
        original = snapshot(
            branches=["alpha", "beta"],
            evidence=[observation("a"), observation("b", "beta")],
            checks=[declared_check("ca", evidence_ids=["a"]),
                    declared_check("cb", "beta", evidence_ids=["b"])],
        )
        self.assert_gaps(self.branch(checkpoint.project(original)))
        added = deepcopy(original)
        added["evidence"].append(observation("new", relation="challenges"))
        view = checkpoint.project(added)
        self.assertEqual(self.branch(view)["stale_check_ids"], ["ca"])
        self.assert_gaps(self.branch(view), "no-current-declared-check")
        self.assertEqual(self.branch(view, "beta")["stale_check_ids"], [])
        self.assert_gaps(self.branch(view, "beta"))

        # Removing applicability while retaining known evidence IDs also makes
        # the check stale; physically missing referenced IDs are invalid below.
        removed = deepcopy(original)
        removed["evidence"][0]["basis_revision"] = "past"
        alpha = self.branch(checkpoint.project(removed))
        self.assertEqual(alpha["stale_check_ids"], ["ca"])
        self.assert_gaps(alpha, "no-applicable-evidence", "no-current-declared-check")

    def test_basis_change_stales_evidence_and_checks_without_rewriting_input(self):
        data = populated_snapshot()
        data["basis_revision"] = "new-question-inputs-and-methods"
        before = deepcopy(data)
        branch = self.branch(checkpoint.project(data))
        self.assertEqual(branch["applicable_evidence_ids"], [])
        self.assertEqual(branch["stale_evidence_ids"], ["e1"])
        self.assertEqual(branch["stale_check_ids"], ["c1"])
        self.assert_gaps(branch, "no-applicable-evidence", "no-current-declared-check")
        self.assertEqual(data, before)

    def test_shared_origin_groups_include_stale_and_same_branch_copies_not_singletons(self):
        evidence = [
            observation("z2", origin="z-origin", basis="past"),
            observation("z1", origin="z-origin", basis="past"),
            observation("solo", origin="singleton"),
            observation("a2", origin="a-origin"),
            observation("a1", origin="a-origin"),
        ]
        view = checkpoint.project(snapshot(evidence=evidence))
        self.assertEqual(view["shared_origin_groups"], [
            {"origin": "a-origin", "evidence_ids": ["a1", "a2"]},
            {"origin": "z-origin", "evidence_ids": ["z1", "z2"]},
        ])

    def test_id_namespaces_are_separate_and_receipts_are_opaque(self):
        data = snapshot(branches=["same"], evidence=[observation(
            "same", "same", origin="https://invalid.example/raw", receipt="/not/read/evidence")],
            checks=[declared_check("same", "same", evidence_ids=["same"],
                                   receipt="https://invalid.example/check?token=opaque")])
        view = checkpoint.project(data)
        self.assertEqual(self.branch(view, "same")["current_declared_checks"][0]["receipt"],
                         "https://invalid.example/check?token=opaque")

    def test_unicode_identifiers_are_exact_and_sort_lexically(self):
        names = ["é", "e\u0301", "😀", "Z", "a"]
        view = checkpoint.project(snapshot(branches=names))
        self.assertEqual([row["id"] for row in view["branches"]], ["Z", "a", "e\u0301", "é", "😀"])

    def test_projection_is_silent_and_does_not_mutate_or_share_mutable_containers(self):
        data = snapshot(branches=["beta", "alpha"], evidence=[
            observation("e2", origin="shared"), observation("e1", origin="shared")],
            checks=[declared_check(evidence_ids=["e2", "e1"])])
        before = deepcopy(data)
        stdout, stderr = io.StringIO(), io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            first = checkpoint.project(data)
            second = checkpoint.project(data)
        self.assertEqual((stdout.getvalue(), stderr.getvalue()), ("", ""))
        self.assertEqual(data, before)
        self.assertEqual(first, second)
        self.assertFalse(mutable_ids(data) & mutable_ids(first))
        self.assertFalse(mutable_ids(first) & mutable_ids(second))
        first["non_claims"].append("not a real claim")
        self.branch(first)["current_declared_checks"][0]["receipt"] = "changed-output"
        first["shared_origin_groups"][0]["evidence_ids"].append("changed-output")
        self.assertEqual(checkpoint.project(data), second)
        data["checks"][0]["receipt"] = "changed-input"
        data["checks"][0]["evidence_ids"].clear()
        self.assertEqual(self.branch(second)["current_declared_checks"][0]["receipt"], "receipt:c1")
        self.assertEqual(self.branch(second)["current_declared_checks"][0]["result"], "passed")

    def test_permutations_have_identical_canonical_projection(self):
        data = snapshot(branches=["gamma", "alpha", "beta"], evidence=[
            observation("c", "gamma", origin="z"), observation("a", origin="z"),
            observation("b", relation="challenges", origin="a")], checks=[
            declared_check("z", "gamma", evidence_ids=["c"]),
            declared_check("a", evidence_ids=["b", "a"]),
            declared_check("b", "beta", evidence_ids=[])])
        expected = json.dumps(checkpoint.project(data), ensure_ascii=False)
        # Each independent collection and check evidence-set order is varied;
        # expectations come from one fixed hand-shaped snapshot, not a sorter.
        for branch_order, evidence_order in itertools.product(
                itertools.permutations(data["branches"]), itertools.permutations(data["evidence"])):
            with self.subTest(branches=branch_order,
                              evidence=[row["id"] for row in evidence_order]):
                variant = snapshot(branches=branch_order, evidence=deepcopy(evidence_order),
                                   checks=list(reversed(deepcopy(data["checks"]))))
                for check in variant["checks"]:
                    check["evidence_ids"].reverse()
                variant = dict(reversed(list(variant.items())))
                self.assertEqual(json.dumps(checkpoint.project(variant), ensure_ascii=False), expected)


class ResearchCheckpointValidationTests(unittest.TestCase):
    def assert_invalid(self, data):
        before = deepcopy(data)
        with self.assertRaises(ValueError) as error:
            checkpoint.project(data)
        self.assertNotIn(CANARY, str(error.exception))
        self.assertEqual(data, before)

    def test_exact_object_keys_at_each_boundary(self):
        base = populated_snapshot()
        for path in ((), ("evidence", 0), ("checks", 0)):
            for key in at_path(base, path):
                with self.subTest(path=path, missing=key):
                    data = deepcopy(base)
                    del at_path(data, path)[key]
                    self.assert_invalid(data)
            with self.subTest(path=path, extra=True):
                data = deepcopy(base)
                at_path(data, path)["unexpected-" + CANARY] = CANARY
                self.assert_invalid(data)

    def test_exact_builtin_types_without_coercion(self):
        class DictSubclass(dict):
            pass

        class ListSubclass(list):
            pass

        class StringSubclass(str):
            pass

        base = populated_snapshot()
        invalid_objects = [None, False, 1, 1.0, "{}", [], ()]
        for path in ((), ("evidence", 0), ("checks", 0)):
            for replacement in [*invalid_objects, DictSubclass(at_path(base, path))]:
                with self.subTest(path=path, type=type(replacement).__name__):
                    data = replacement if not path else changed(base, path, replacement)
                    self.assert_invalid(data)
        for path in (("branches",), ("evidence",), ("checks",), ("checks", 0, "evidence_ids")):
            for replacement in (None, False, 0, {}, "alpha", (), ListSubclass(at_path(base, path))):
                with self.subTest(path=path, type=type(replacement).__name__):
                    self.assert_invalid(changed(base, path, replacement))
        string_paths = [("schema",), ("basis_revision",), ("branches", 0)]
        string_paths.extend(("evidence", 0, field) for field in base["evidence"][0])
        string_paths.extend(("checks", 0, field) for field in base["checks"][0] if field != "evidence_ids")
        string_paths.append(("checks", 0, "evidence_ids", 0))
        for path in string_paths:
            for replacement in (None, False, True, 0, 1, 1.0, [], {}, b"text",
                                StringSubclass(at_path(base, path))):
                with self.subTest(path=path, type=type(replacement).__name__):
                    self.assert_invalid(changed(base, path, replacement))

    def test_nonempty_strings_and_exact_enums(self):
        base = populated_snapshot()
        paths = [("schema",), ("basis_revision",), ("branches", 0)]
        paths.extend(("evidence", 0, field) for field in base["evidence"][0])
        paths.extend(("checks", 0, field) for field in base["checks"][0] if field != "evidence_ids")
        paths.append(("checks", 0, "evidence_ids", 0))
        for path in paths:
            with self.subTest(empty=path):
                self.assert_invalid(changed(base, path, ""))
        for path, values in (
            (("schema",), ["lunacy-research-checkpoint-v2", SCHEMA + " ", SCHEMA.upper()]),
            (("evidence", 0, "relation"), ["support", "SUPPORTS", " supports", "contradicts"]),
            (("checks", 0, "result"), ["pass", "PASSED", "passed ", "unknown"]),
        ):
            for value in values:
                with self.subTest(path=path, invalid=value):
                    self.assert_invalid(changed(base, path, value))

    def test_uniqueness_and_reference_integrity(self):
        base = populated_snapshot()
        cases = {
            "no-branches": changed(base, ("branches",), []),
            "duplicate-branch": changed(base, ("branches",), ["alpha", "alpha"]),
            "duplicate-evidence": changed(base, ("evidence",), [observation(), observation()]),
            "duplicate-check": changed(base, ("checks",), [declared_check(), declared_check()]),
            "unknown-evidence-branch": changed(base, ("evidence", 0, "branch"), "unknown"),
            "unknown-check-branch": changed(base, ("checks", 0, "branch"), "unknown"),
            "unknown-evidence-reference": changed(base, ("checks", 0, "evidence_ids"), ["missing"]),
            "duplicate-evidence-reference": changed(base, ("checks", 0, "evidence_ids"), ["e1", "e1"]),
            "removed-referenced-evidence": changed(base, ("evidence",), []),
            "cross-branch-reference": snapshot(branches=["alpha", "beta"], evidence=[observation()],
                                                checks=[declared_check(branch="beta")]),
            "stale-cross-branch-reference": snapshot(branches=["alpha", "beta"],
                evidence=[observation(basis="past")], checks=[declared_check(branch="beta", basis="past")]),
        }
        for label, data in cases.items():
            with self.subTest(case=label):
                self.assert_invalid(data)

    def test_all_string_limits_accept_boundary_and_reject_one_over(self):
        for size, accepted in ((127, True), (128, True), (129, False)):
            for character in ("a", "😀"):
                identifier = character * size
                cases = {
                    "branch-id-and-refs": snapshot(branches=[identifier],
                        evidence=[observation(branch=identifier)], checks=[declared_check(branch=identifier)]),
                    "evidence-id-and-ref": snapshot(evidence=[observation(identifier)],
                        checks=[declared_check(evidence_ids=[identifier])]),
                    "check-id": snapshot(evidence=[observation()], checks=[declared_check(identifier)]),
                }
                for label, data in cases.items():
                    with self.subTest(field=label, size=size, character=character):
                        if accepted:
                            checkpoint.project(data)
                        else:
                            self.assert_invalid(data)
        long_paths = [("basis_revision",), ("evidence", 0, "basis_revision"),
                      ("evidence", 0, "origin"), ("evidence", 0, "receipt"),
                      ("checks", 0, "basis_revision"), ("checks", 0, "receipt")]
        for path, size, character in itertools.product(long_paths, (2047, 2048, 2049), ("x", "😀")):
            with self.subTest(path=path, size=size, character=character):
                data = changed(populated_snapshot(), path, character * size)
                if size <= 2048:
                    checkpoint.project(data)
                else:
                    self.assert_invalid(data)

    def test_array_cap_boundaries(self):
        for size in (127, 128, 129):
            with self.subTest(array="branches", size=size):
                data = snapshot(branches=[f"b{i}" for i in range(size)])
                if size <= 128:
                    self.assertEqual(len(checkpoint.project(data)["branches"]), size)
                else:
                    self.assert_invalid(data)
        for size in (2047, 2048, 2049):
            with self.subTest(array="evidence", size=size):
                data = snapshot(evidence=[observation(f"e{i}") for i in range(size)])
                if size <= 2048:
                    self.assertEqual(len(checkpoint.project(data)["branches"][0]["applicable_evidence_ids"]), size)
                else:
                    self.assert_invalid(data)
        for size in (511, 512, 513):
            with self.subTest(array="checks", size=size):
                data = snapshot(checks=[declared_check(f"c{i}", evidence_ids=[]) for i in range(size)])
                if size <= 512:
                    self.assertEqual(len(checkpoint.project(data)["branches"][0]["current_declared_checks"]), size)
                else:
                    self.assert_invalid(data)
        ids = [f"e{i}" for i in range(2048)]
        data = snapshot(evidence=[observation(identifier) for identifier in ids],
                        checks=[declared_check(evidence_ids=ids)])
        self.assertEqual(len(checkpoint.project(data)["branches"][0]["current_declared_checks"]), 1)
        data["checks"][0]["evidence_ids"].append(ids[0])
        self.assert_invalid(data)


class ResearchCheckpointCliTests(unittest.TestCase):
    def invoke(self, *arguments, data=None):
        return subprocess.run([sys.executable, "-B", str(SCRIPT), *map(str, arguments)],
                              input=data, capture_output=True, timeout=5, check=False)

    def assert_refused(self, result):
        self.assertEqual((result.returncode, result.stdout), (2, b""), result.stderr)
        self.assertTrue(result.stderr.strip())
        result.stderr.decode("utf-8", "strict")
        self.assertNotIn(b"Traceback", result.stderr)
        self.assertNotIn(CANARY.encode(), result.stderr)

    def encode(self, data):
        return json.dumps(data, ensure_ascii=False).encode("utf-8")

    def test_file_and_stdin_match_public_api_and_do_not_modify_input(self):
        data = snapshot(evidence=[observation(relation="challenges", receipt="opaque:😀")],
                        checks=[declared_check(result="failed")])
        payload = self.encode(data)
        expected = checkpoint.project(data)
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "checkpoint.json"
            source.write_bytes(payload)
            before = set(Path(directory).iterdir())
            from_file = self.invoke("inspect", source)
            from_stdin = self.invoke("inspect", "-", data=payload)
            self.assertEqual(source.read_bytes(), payload)
            self.assertEqual(set(Path(directory).iterdir()), before)
        for result in (from_file, from_stdin):
            self.assertEqual((result.returncode, result.stderr), (0, b""))
            self.assertEqual(json.loads(result.stdout), expected)
            self.assertTrue(result.stdout.endswith(b"\n"))
        self.assertEqual(from_file.stdout, from_stdin.stdout)

    def test_structurally_valid_failed_and_unavailable_checks_still_exit_zero(self):
        for result_name in ("passed", "failed", "unavailable"):
            with self.subTest(result=result_name):
                data = snapshot(evidence=[observation()], checks=[declared_check(result=result_name)])
                result = self.invoke("inspect", "-", data=self.encode(data))
                self.assertEqual((result.returncode, result.stderr), (0, b""))
                branch = json.loads(result.stdout)["branches"][0]
                self.assertEqual(branch["current_declared_checks"][0]["result"], result_name)

    def test_cli_output_is_canonical_across_collection_order(self):
        data = snapshot(branches=["beta", "alpha"], evidence=[
            observation("z", origin="same"), observation("a", relation="challenges", origin="same")],
            checks=[declared_check("z", evidence_ids=["z", "a"]),
                    declared_check("a", "beta", evidence_ids=[])])
        permuted = deepcopy(data)
        for key in ("branches", "evidence", "checks"):
            permuted[key].reverse()
        for check in permuted["checks"]:
            check["evidence_ids"].reverse()
        first = self.invoke("inspect", "-", data=self.encode(data))
        second = self.invoke("inspect", "-", data=self.encode(permuted))
        self.assertEqual((first.returncode, second.returncode), (0, 0))
        self.assertEqual(first.stdout, second.stdout)

    def test_malformed_duplicate_nonfinite_and_invalid_utf8_inputs_are_redacted(self):
        valid = self.encode(populated_snapshot())
        duplicate_top = valid[:-1] + b', "schema": "' + SCHEMA.encode() + b'"}'
        duplicate_escaped = valid[:-1] + b', "sc\\u0068ema": "' + SCHEMA.encode() + b'"}'
        duplicate_record = valid.replace(b'"id": "e1"', b'"id": "e1", "id": "' + CANARY.encode() + b'"')
        cases = {
            "empty": b"",
            "malformed-secret": b'{"receipt": "' + CANARY.encode() + b'", broken}',
            "trailing-document": valid + b" {}",
            "duplicate-top": duplicate_top,
            "duplicate-escaped-key": duplicate_escaped,
            "duplicate-record": duplicate_record,
            "invalid-utf8": valid.replace(b"raw-origin", b"\xff" + CANARY.encode()),
            "truncated-utf8": valid + b"\xf0\x9f",
            "deep-json": b"[" * 1200 + b"]" * 1200,
            "oversized-integer": b"9" * 5000,
        }
        for token in (b"NaN", b"Infinity", b"-Infinity", b"1e99999"):
            cases[token.decode()] = valid.replace(b'"receipt:e1"', token)
        for label, payload in cases.items():
            with self.subTest(case=label):
                self.assert_refused(self.invoke("inspect", "-", data=payload))

    def test_schema_failures_do_not_echo_keys_values_or_receipt_payloads(self):
        base = populated_snapshot()
        cases = [
            changed(base, ("evidence", 0, "relation"), CANARY),
            changed(base, ("checks", 0, "result"), CANARY),
            changed(base, ("checks", 0, "evidence_ids"), [CANARY]),
            changed(base, ("evidence", 0, "branch"), CANARY),
            changed(base, ("evidence", 0, "receipt"), {CANARY: CANARY}),
            changed(base, ("checks", 0, "receipt"), CANARY * 100),
        ]
        extra = deepcopy(base)
        extra[CANARY] = CANARY
        cases.append(extra)
        for number, data in enumerate(cases):
            with self.subTest(case=number):
                self.assert_refused(self.invoke("inspect", "-", data=self.encode(data)))

    def test_file_and_stdin_utf8_byte_limit_at_boundary(self):
        # Non-ASCII makes a byte-bound check distinguishable from a character
        # count: the one-byte-over payload still has fewer than 1 Mi characters.
        payload = self.encode(snapshot(evidence=[observation(receipt="é" * 2048)]))
        at_limit = payload + b" " * (MAX_BYTES - len(payload))
        self.assertEqual(len(at_limit), MAX_BYTES)
        self.assertLess(len((at_limit + b" ").decode("utf-8")), MAX_BYTES)
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "checkpoint.json"
            for label, body, accepted in (("at-limit", at_limit, True),
                                          ("one-over", at_limit + b" ", False)):
                source.write_bytes(body)
                for medium in ("stdin", "file"):
                    with self.subTest(case=label, medium=medium):
                        result = self.invoke("inspect", "-", data=body) if medium == "stdin" else self.invoke("inspect", source)
                        if accepted:
                            self.assertEqual((result.returncode, result.stderr), (0, b""))
                        else:
                            self.assert_refused(result)
                self.assertEqual(source.read_bytes(), body)

    def test_oversize_stdin_finishes_without_waiting_for_writer_eof(self):
        process = subprocess.Popen([sys.executable, "-B", str(SCRIPT), "inspect", "-"],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE)

        def feed_without_closing():
            try:
                process.stdin.write(b" " * (MAX_BYTES + 1))
                process.stdin.flush()
            except (BrokenPipeError, OSError):
                pass  # An early refusal is allowed; this pipe remains caller-owned.

        writer = threading.Thread(target=feed_without_closing, daemon=True)
        writer.start()
        try:
            process.wait(timeout=5)
            result = subprocess.CompletedProcess(process.args, process.returncode,
                                                 process.stdout.read(), process.stderr.read())
            self.assert_refused(result)
        finally:
            if process.poll() is None:
                process.kill()
            process.wait(timeout=5)
            writer.join(timeout=5)
            process.stdin.close()
            process.stdout.close()
            process.stderr.close()
        self.assertFalse(writer.is_alive())

    def test_missing_directory_fifo_and_character_device_fail_without_hanging(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fifo = root / "checkpoint.fifo"
            os.mkfifo(fifo)
            sources = [root / "missing.json", root, fifo]
            if Path("/dev/null").exists():
                sources.append(Path("/dev/null"))
            for source in sources:
                with self.subTest(source=source.name):
                    self.assert_refused(self.invoke("inspect", source))

    def test_argument_errors_are_not_successful_empty_projections(self):
        for arguments in ([], ["inspect"], ["unknown", "-"], ["inspect", "-", "extra"]):
            with self.subTest(arguments=arguments):
                self.assert_refused(self.invoke(*arguments, data=b""))


if __name__ == "__main__":
    unittest.main()
