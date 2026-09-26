#!/usr/bin/env python3
"""Assemble the two-skill plugin without modifying an installation."""

import argparse
from pathlib import Path
import shutil
import sys

from release_inputs import NATIVE_TREES, copy_entries, select_release_inputs


ROOT = Path(__file__).resolve().parents[1]


def _validate_guidance(plan):
    """Load the repository-only preflight without adding it to the package."""
    sys.path.insert(0, str(ROOT))
    try:
        from maintainer.read_map import GOLDEN_SOURCE, ROOT_GUIDANCE, validate_source
        owners = [name for name in ROOT_GUIDANCE
                  if Path(name) in plan.root_files]
        owners.extend(relative.as_posix() for relative in plan.native_entries
                      if relative.parts[0] in {"orchestrator", "worker"}
                      and relative.suffix.lower() == ".md"
                      and (plan.source / relative).is_file())
        owners.append(GOLDEN_SOURCE)
        validate_source(plan.source, published_sources=plan.published_sources,
                        guidance_paths=owners)
    finally:
        if sys.path[0] == str(ROOT):
            sys.path.pop(0)


def build(destination):
    destination = destination.absolute()
    if destination.name != "lunacy-native":
        raise ValueError("destination folder must be named lunacy-native")
    if destination.is_symlink() or destination.exists():
        raise ValueError(f"refusing existing destination: {destination}")
    if destination.resolve().is_relative_to(ROOT):
        raise ValueError("destination must be outside the source checkout")
    plan = select_release_inputs(ROOT)
    _validate_guidance(plan)
    # mkdir owns only this new output; do not overwrite or clean up other paths.
    destination.mkdir()
    shutil.copy2(ROOT / "LICENSE", destination / "LICENSE")
    copy_entries(plan, plan.template_entries, destination,
                 strip=Path("packaging/lunacy-native"))
    native = destination / "skills" / "lunacy"
    native.mkdir()
    for relative in plan.root_files:
        shutil.copy2(ROOT / relative, native / relative)
    copy_entries(plan, plan.native_entries, native)
    return destination


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", type=Path, help="new lunacy-native folder; parent must exist")
    args = parser.parse_args()
    try:
        result = build(args.destination)
    except (OSError, ValueError) as error:
        print(f"plugin build failed: {error}", file=sys.stderr)
        return 1
    print(f"Built {result}; no installation or configuration changes made.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
