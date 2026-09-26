#!/usr/bin/env python3
"""Regression tests for the shell recipes published in README.md."""

import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest


REPOSITORY = Path(__file__).resolve().parents[1]
README = REPOSITORY / "README.md"
SHELL = Path("/bin/sh")
SOURCE_COMPOSER = REPOSITORY / "packaging/build_standalone.py"


def shell_fences_in_section(markdown, heading):
    """Return shell fences in one uniquely named third-level section."""
    marker = f"### {heading}\n"
    if markdown.count(marker) != 1:
        raise ValueError(f"expected exactly one section {heading!r}")
    section_lines = []
    for line in markdown.split(marker, 1)[1].splitlines(keepends=True):
        if line.startswith("## ") or line.startswith("### "):
            break
        section_lines.append(line)
    section = "".join(section_lines)

    fences = []
    parts = section.split("```")
    if len(parts) % 2 == 0:
        raise ValueError("unterminated fenced block in target section")
    for index in range(1, len(parts), 2):
        fenced = parts[index]
        language, separator, body = fenced.partition("\n")
        if separator and language == "sh":
            fences.append(body)
    return fences


def plugin_update_recipe(markdown):
    fences = shell_fences_in_section(
        markdown, "Update an existing plugin (preferred for plugin users)"
    )
    if len(fences) != 1:
        raise ValueError("expected exactly one plugin-update shell fence")
    return fences[0]


def standalone_copy_recipe(markdown, source, destination):
    fences = shell_fences_in_section(markdown, "Install a standalone skill instead")
    if len(fences) != 1:
        raise ValueError("expected exactly one standalone-copy shell fence")
    recipe = fences[0]
    replacements = {
        "cd <source-checkout> || exit": f"cd {shlex.quote(os.fspath(source))} || exit",
        'dest="${CODEX_HOME:-$HOME/.codex}/skills/lunacy-native"': (
            f"dest={shlex.quote(os.fspath(destination))}"
        ),
        'python3 -B packaging/build_standalone.py "$PWD" "$dest"': (
            f"{shlex.quote(sys.executable)} -B packaging/build_standalone.py \"$PWD\" \"$dest\""
        )
    }
    for original, replacement in replacements.items():
        if recipe.count(original) != 1:
            raise ValueError(f"expected exactly one recipe binding: {original}")
        recipe = recipe.replace(original, replacement)
    return recipe


@unittest.skipUnless(
    os.name == "posix" and SHELL.is_file(), "README recipes require POSIX /bin/sh"
)
class PluginUpdateRecipeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.markdown = README.read_text(encoding="utf-8")
        cls.recipe = plugin_update_recipe(cls.markdown)

    def run_recipe(
        self,
        recipe=None,
        fail_helper="",
        marketplace_name="marketplace-a",
        helper_stderr="",
        spaced_paths=False,
    ):
        with tempfile.TemporaryDirectory(prefix="lunacy-plugin-recipe.") as temporary:
            root = Path(temporary)
            stubs = root / "stubs"
            stubs.mkdir()
            calls = root / "calls"
            argv_dir = root / "argv"
            argv_dir.mkdir()
            helper_root = root / "external plugin creator"
            helper_root.mkdir()
            plugin_path = (
                root / "plugin root" / "lunacy-native-plugin"
                if spaced_paths
                else Path("/path/to/existing/lunacy-native-plugin")
            )
            marketplace_path = (
                root / "marketplace file.json"
                if spaced_paths
                else Path("/path/to/actual/marketplace.json")
            )
            if spaced_paths:
                plugin_path.parent.mkdir()
                plugin_path.mkdir()
                marketplace_path.touch()
            python_stub = stubs / "python3"
            python_stub.write_text(
                """#!/bin/sh
case "$1" in
  scripts/validate_plugin.py) ordinal=1; code=41 ;;
  scripts/read_marketplace_name.py) ordinal=2; code=42 ;;
  scripts/update_plugin_cachebuster.py) ordinal=3; code=43 ;;
  *) ordinal=unexpected; code=99 ;;
esac
printf 'python3' >> "$CALL_LOG"
printf ' <%s>' "$@" >> "$CALL_LOG"
printf '\n' >> "$CALL_LOG"
printf '%s\\000' "$@" > "$ARGV_DIR/python-$ordinal.argv"
printf '%s\n' "$PWD" > "$ARGV_DIR/python-$ordinal.cwd"
if [ "$ordinal" = 2 ]; then
  if [ -n "$MARKETPLACE_NAME" ]; then printf '%s\n' "$MARKETPLACE_NAME"; fi
  if [ -n "$HELPER_STDERR" ]; then printf '%s\n' "$HELPER_STDERR" >&2; fi
fi
if [ "$FAIL_HELPER" = "$ordinal" ]; then exit "$code"; fi
exit 0
""",
                encoding="utf-8",
            )
            codex_stub = stubs / "codex"
            codex_stub.write_text(
                """#!/bin/sh
printf 'codex' >> "$CALL_LOG"
printf ' <%s>' "$@" >> "$CALL_LOG"
printf '\n' >> "$CALL_LOG"
printf '%s\\000' "$@" > "$ARGV_DIR/codex.argv"
exit 0
""",
                encoding="utf-8",
            )
            python_stub.chmod(0o700)
            codex_stub.chmod(0o700)
            environment = os.environ.copy()
            environment.update(
                {
                    "PATH": os.fspath(stubs),
                    "CALL_LOG": os.fspath(calls),
                    "ARGV_DIR": os.fspath(argv_dir),
                    "FAIL_HELPER": fail_helper,
                    "MARKETPLACE_NAME": marketplace_name,
                    "HELPER_STDERR": helper_stderr,
                }
            )
            selected = self.recipe if recipe is None else recipe
            selected = selected.replace(
                "cd <external-plugin-creator-root> || exit",
                f"cd {shlex.quote(os.fspath(helper_root))} || exit",
            )
            selected = selected.replace(
                "/path/to/existing/lunacy-native-plugin",
                shlex.quote(os.fspath(plugin_path)),
            )
            selected = selected.replace(
                "/path/to/actual/marketplace.json",
                shlex.quote(os.fspath(marketplace_path)),
            )
            result = subprocess.run(
                [os.fspath(SHELL), "-c", selected],
                cwd=REPOSITORY,
                env=environment,
                text=True,
                capture_output=True,
                timeout=5,
                check=False,
            )
            observed = calls.read_text(encoding="utf-8").splitlines() if calls.exists() else []
            argv = {
                path.stem: [
                    item.decode("utf-8")
                    for item in path.read_bytes().split(b"\0")
                    if item
                ]
                for path in argv_dir.glob("*.argv")
            }
            cwd = {
                path.stem: path.read_text(encoding="utf-8").rstrip("\n")
                for path in argv_dir.glob("*.cwd")
            }
            return result, observed, argv, cwd, {
                "helper_root": os.fspath(helper_root),
                "plugin_path": os.fspath(plugin_path),
                "marketplace_path": os.fspath(marketplace_path),
            }

    def test_two_helper_identities_reach_one_final_argument_in_order(self):
        for name in ("marketplace-a", "marketplace-b"):
            with self.subTest(name=name):
                result, calls, argv, _, _ = self.run_recipe(marketplace_name=name)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(len(calls), 4)
                self.assertIn("scripts/validate_plugin.py", calls[0])
                self.assertIn("scripts/read_marketplace_name.py", calls[1])
                self.assertIn("scripts/update_plugin_cachebuster.py", calls[2])
                self.assertEqual(argv["codex"], ["plugin", "add", f"lunacy-native@{name}"])

    def test_each_helper_failure_preserves_status_and_suppresses_later_commands(self):
        expected = (
            ("1", 41, 1),
            ("2", 42, 2),
            ("3", 43, 3),
        )
        for helper, status, call_count in expected:
            with self.subTest(helper=helper):
                result, calls, _, _, _ = self.run_recipe(
                    fail_helper=helper,
                    marketplace_name="marketplace-a",
                    helper_stderr="helper diagnostic" if helper == "2" else "",
                )
                self.assertEqual(result.returncode, status)
                self.assertEqual(len(calls), call_count)
                if helper == "2":
                    self.assertEqual(result.stdout, "")
                    self.assertIn("helper diagnostic", result.stderr)
                if helper in {"1", "2"}:
                    self.assertNotIn("update_plugin_cachebuster", "\n".join(calls))
                self.assertNotIn("codex", "\n".join(calls))

    def test_empty_successful_helper_output_stops_before_cachebuster(self):
        result, calls, _, _, _ = self.run_recipe(marketplace_name="")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(len(calls), 2)
        self.assertIn("marketplace helper returned an empty identity", result.stderr)

    def test_stderr_is_diagnostic_not_identity_data(self):
        result, _, argv, _, _ = self.run_recipe(
            marketplace_name="marketplace-a", helper_stderr="not-an-identity"
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("not-an-identity", result.stderr)
        self.assertEqual(
            argv["codex"], ["plugin", "add", "lunacy-native@marketplace-a"]
        )

    def test_space_containing_selected_paths_arrive_as_single_arguments(self):
        result, calls, argv, cwd, paths = self.run_recipe(spaced_paths=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(calls), 4)
        self.assertEqual(
            argv["python-1"], ["scripts/validate_plugin.py", paths["plugin_path"]]
        )
        self.assertEqual(
            argv["python-2"],
            ["scripts/read_marketplace_name.py", "--marketplace-path", paths["marketplace_path"]],
        )
        self.assertEqual(
            argv["python-3"],
            ["scripts/update_plugin_cachebuster.py", paths["plugin_path"]],
        )
        self.assertEqual(argv["codex"], ["plugin", "add", "lunacy-native@marketplace-a"])
        self.assertEqual(set(cwd.values()), {paths["helper_root"]})

    def test_missing_failure_guard_changes_the_expected_observation(self):
        guarded = """helper_status=$?
if [ "$helper_status" -ne 0 ]; then
  exit "$helper_status"
fi
"""
        self.assertEqual(self.recipe.count(guarded), 1)
        mutant = self.recipe.replace(guarded, "")
        result, calls, _, _, _ = self.run_recipe(
            recipe=mutant, fail_helper="2", marketplace_name="marketplace-a"
        )
        self.assertNotEqual((result.returncode, len(calls)), (42, 2))
        self.assertEqual(result.returncode, 0)
        self.assertEqual(len(calls), 4)

    def test_missing_ambiguous_or_unterminated_target_fence_refuses_extraction(self):
        heading = "### Update an existing plugin (preferred for plugin users)\n"
        cases = (
            self.markdown.replace("```sh\n" + self.recipe, "```text\n" + self.recipe, 1),
            self.markdown.replace(heading, heading + heading, 1),
            self.markdown.replace(
                self.recipe + "```", self.recipe + "```\n\n```sh\ntrue\n```", 1
            ),
            self.markdown.replace(self.recipe + "```", self.recipe, 1),
        )
        for markdown in cases:
            with self.subTest():
                with self.assertRaises(ValueError):
                    plugin_update_recipe(markdown)


@unittest.skipUnless(
    os.name == "posix" and SHELL.is_file() and SOURCE_COMPOSER.is_file(),
    "standalone composition tests are source-checkout only (packaging is absent)",
)
class StandaloneCopyRecipeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.markdown = README.read_text(encoding="utf-8")

    def run_recipe(self, destination):
        recipe = standalone_copy_recipe(self.markdown, REPOSITORY, destination)
        return subprocess.run(
            [os.fspath(SHELL), "-c", recipe],
            cwd=REPOSITORY,
            text=True,
            capture_output=True,
            timeout=10,
            check=False,
        )

    def test_fresh_copy_matches_complete_documented_source_tree(self):
        with tempfile.TemporaryDirectory(prefix="lunacy-standalone-recipe.") as temporary:
            destination = Path(temporary) / "outside-discovery" / "lunacy-native"
            destination.parent.mkdir()
            result = self.run_recipe(destination)
            self.assertEqual(result.returncode, 0, result.stderr)

            roots = ("orchestrator", "worker", "scripts", "tests")
            expected_files = {Path(name) for name in
                              ("SKILL.md", "WORKSPACE.md", "OPERATOR.md", "README.md", "LICENSE")}
            for root in roots:
                expected_files.update(
                    path.relative_to(REPOSITORY) for path in (REPOSITORY / root).rglob("*")
                    if path.is_file() and "__pycache__" not in path.parts
                    and path.suffix not in {".pyc", ".pyo"})
            actual_files = {path.relative_to(destination) for path in destination.rglob("*")
                            if path.is_file()}
            self.assertEqual(actual_files, expected_files)

            changed = []
            for relative in sorted(expected_files):
                source = REPOSITORY / relative
                copied = destination / relative
                if source.is_file() and source.read_bytes() != copied.read_bytes():
                    changed.append(relative)
            self.assertEqual(changed, [Path("SKILL.md")])
            expected_skill = (REPOSITORY / "SKILL.md").read_text(encoding="utf-8").replace(
                "name: lunacy\n", "name: lunacy-native\n"
            )
            self.assertEqual(
                (destination / "SKILL.md").read_text(encoding="utf-8"), expected_skill
            )

    def test_existing_destination_refuses_without_changing_bytes(self):
        with tempfile.TemporaryDirectory(prefix="lunacy-standalone-recipe.") as temporary:
            destination = Path(temporary) / "existing"
            destination.mkdir()
            sentinel = destination / "sentinel"
            sentinel.write_bytes(b"unchanged\x00bytes")
            before = sentinel.read_bytes()
            result = self.run_recipe(destination)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(sentinel.read_bytes(), before)
            self.assertEqual({path.name for path in destination.iterdir()}, {"sentinel"})

    def test_dangling_symlink_destination_refuses_and_preserves_link(self):
        with tempfile.TemporaryDirectory(prefix="lunacy-standalone-recipe.") as temporary:
            root = Path(temporary)
            destination = root / "dangling"
            target = root / "missing-target"
            destination.symlink_to(target)
            result = self.run_recipe(destination)
            self.assertNotEqual(result.returncode, 0)
            self.assertTrue(destination.is_symlink())
            self.assertEqual(destination.readlink(), target)
            self.assertFalse(target.exists())

    def test_copied_guidance_labels_source_only_and_non_transfer_boundaries(self):
        self.assertIn("<source-checkout>", self.markdown)
        self.assertIn("**source-checkout only**", self.markdown)
        self.assertIn("<external-plugin-creator-root>", self.markdown)
        self.assertIn("<plugin-root>", self.markdown)
        self.assertIn("do **not** transfer release bytes", self.markdown)
        self.assertIn("intentionally absent from the finished artifact", self.markdown)
        standalone = self.markdown.split("### Install a standalone skill instead\n", 1)[1]
        standalone = standalone.split("\n## ", 1)[0]
        self.assertNotIn("release/native-0.2.0-rc.1", standalone)
        self.assertIn("revision that contains both `packaging/build_standalone.py`", standalone)
        self.assertIn("source revision lacks the standalone composer prerequisites", standalone)


if __name__ == "__main__":
    unittest.main()
