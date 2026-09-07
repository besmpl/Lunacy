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
    if len(fences) != 2:
        raise ValueError("expected clone and standalone-copy shell fences")
    recipe = fences[1]
    replacements = {
        "src=/path/to/lunacy-native-source": f"src={shlex.quote(os.fspath(source))}",
        'dest="${CODEX_HOME:-$HOME/.codex}/skills/lunacy-native"': (
            f"dest={shlex.quote(os.fspath(destination))}"
        ),
        'python3 -B - "$dest/SKILL.md" <<\'PY\'': (
            f"{shlex.quote(sys.executable)} -B - \"$dest/SKILL.md\" <<'PY'"
        ),
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

    def run_recipe(self, recipe=None, fail_helper=""):
        with tempfile.TemporaryDirectory(prefix="lunacy-plugin-recipe.") as temporary:
            root = Path(temporary)
            stubs = root / "stubs"
            stubs.mkdir()
            calls = root / "calls"
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
                    "FAIL_HELPER": fail_helper,
                }
            )
            result = subprocess.run(
                [os.fspath(SHELL), "-c", self.recipe if recipe is None else recipe],
                cwd=REPOSITORY,
                env=environment,
                text=True,
                capture_output=True,
                timeout=5,
                check=False,
            )
            observed = calls.read_text(encoding="utf-8").splitlines() if calls.exists() else []
            return result, observed

    def test_success_runs_all_commands_with_documented_argument_order(self):
        result, calls = self.run_recipe()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            calls,
            [
                "python3 <scripts/validate_plugin.py> </path/to/existing/lunacy-native-plugin>",
                "python3 <scripts/read_marketplace_name.py> <--marketplace-path> </path/to/actual/marketplace.json>",
                "python3 <scripts/update_plugin_cachebuster.py> </path/to/existing/lunacy-native-plugin>",
                "codex <plugin> <add> <lunacy-native@<validated-marketplace-name>>",
            ],
        )

    def test_each_helper_failure_preserves_status_and_suppresses_later_commands(self):
        expected = (
            ("1", 41, 1),
            ("2", 42, 2),
            ("3", 43, 3),
        )
        for helper, status, call_count in expected:
            with self.subTest(helper=helper):
                result, calls = self.run_recipe(fail_helper=helper)
                self.assertEqual(result.returncode, status)
                self.assertEqual(len(calls), call_count)

    def test_missing_failure_guard_changes_the_expected_observation(self):
        guarded = "scripts/read_marketplace_name.py \\\n  --marketplace-path /path/to/actual/marketplace.json || exit"
        unguarded = guarded.removesuffix(" || exit")
        self.assertEqual(self.recipe.count(guarded), 1)
        mutant = self.recipe.replace(guarded, unguarded)
        result, calls = self.run_recipe(recipe=mutant, fail_helper="2")
        self.assertNotEqual((result.returncode, len(calls)), (42, 2))
        self.assertEqual(result.returncode, 0)
        self.assertEqual(len(calls), 4)

    def test_missing_ambiguous_or_unterminated_target_fence_refuses_extraction(self):
        heading = "### Update an existing plugin (preferred for plugin users)\n"
        cases = (
            self.markdown.replace("```sh\n", "```text\n", 1),
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
    os.name == "posix"
    and SHELL.is_file()
    and shutil.which("cp")
    and shutil.which("mkdir"),
    "standalone recipe requires POSIX /bin/sh, cp, and mkdir",
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

            roots = (
                "SKILL.md",
                "WORKSPACE.md",
                "OPERATOR.md",
                "README.md",
                "LICENSE",
                "orchestrator",
                "worker",
                "scripts",
                "tests",
            )
            expected = set()
            for root in roots:
                source = REPOSITORY / root
                expected.add(Path(root))
                if source.is_dir():
                    expected.update(path.relative_to(REPOSITORY) for path in source.rglob("*"))
            actual = {path.relative_to(destination) for path in destination.rglob("*")}
            self.assertEqual(actual, expected)

            changed = []
            for relative in sorted(expected):
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
            self.assertEqual(result.returncode, 73)
            self.assertEqual(sentinel.read_bytes(), before)
            self.assertEqual({path.name for path in destination.iterdir()}, {"sentinel"})

    def test_dangling_symlink_destination_refuses_and_preserves_link(self):
        with tempfile.TemporaryDirectory(prefix="lunacy-standalone-recipe.") as temporary:
            root = Path(temporary)
            destination = root / "dangling"
            target = root / "missing-target"
            destination.symlink_to(target)
            result = self.run_recipe(destination)
            self.assertEqual(result.returncode, 73)
            self.assertTrue(destination.is_symlink())
            self.assertEqual(destination.readlink(), target)
            self.assertFalse(target.exists())


if __name__ == "__main__":
    unittest.main()
