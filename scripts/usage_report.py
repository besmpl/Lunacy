#!/usr/bin/env python3
"""Report token usage and dated API-equivalent costs from selected receipts."""

from __future__ import annotations

import argparse
from collections import defaultdict
from decimal import Decimal
import json
import os
from pathlib import Path
import sys
from typing import Any

from evidence_index import EvidenceError, read_snapshot


SCHEMA = "lunacy-usage-report-v1"
MANIFEST_SCHEMA = "lunacy-usage-input-v1"
DEFAULT_OUTPUT_CAP = 8192
MAX_OUTPUT_CAP = 1024 * 1024
MANIFEST_CAP = 1024 * 1024
MAX_SOURCES = 64
TOTAL_SOURCE_CAP = 64 * 1024 * 1024
MAX_RECORDS = 200_000
FIELDS = ("input", "cache_read", "cache_write", "uncached_input", "output", "reasoning")
RAW_FIELDS = ("input", "cache_read", "cache_write", "output", "reasoning")
PHASES = {"consultation", "breadth", "focus", "design", "implementation", "repair", "acceptance", "unknown"}
RATES = {
    ("openai", "gpt-6-astra"): ("10", "1", "12.5", "50"),
    ("openai", "gpt-5.6-sol"): ("4", ".4", "5", "20"),
    ("openai", "gpt-5.6-luna"): (".2", ".02", ".25", "1.2"),
}
RATE_DATE = "2026-09-10"


class UsageError(Exception):
    pass


class Parser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise UsageError(message)


def load_json(data: bytes, label: str) -> Any:
    def unique(pairs):
        value = {}
        for key, item in pairs:
            if key in value:
                raise UsageError("duplicate JSON object key")
            value[key] = item
        return value
    def constant(_value):
        raise UsageError("nonstandard JSON constant")
    try:
        return json.loads(data.decode("utf-8"), object_pairs_hook=unique,
                          parse_constant=constant)
    except (UnicodeDecodeError, json.JSONDecodeError, UsageError) as exc:
        raise UsageError(f"invalid {label}: {exc}") from exc


def label(value: Any, name: str) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or not value:
        raise UsageError(f"{name} must be a nonempty string or null")
    return value


def parse_manifest(path_text: str) -> tuple[dict[str, Any], dict[str, str]]:
    try:
        if Path(path_text).stat().st_size > MANIFEST_CAP:
            raise UsageError(f"manifest exceeds {MANIFEST_CAP}-byte cap")
    except OSError:
        pass  # read_snapshot supplies the bounded, stable acquisition diagnostic.
    try:
        path, data, digest = read_snapshot(path_text)
    except EvidenceError as exc:
        raise UsageError(str(exc)) from exc
    if len(data) > MANIFEST_CAP:
        raise UsageError(f"manifest exceeds {MANIFEST_CAP}-byte cap")
    value = load_json(data, "manifest JSON")
    if not isinstance(value, dict) or value.get("schema") != MANIFEST_SCHEMA:
        raise UsageError(f"manifest schema must be {MANIFEST_SCHEMA!r}")
    sources = value.get("sources")
    if not isinstance(sources, list) or not sources:
        raise UsageError("manifest sources must be a nonempty array")
    if len(sources) > MAX_SOURCES:
        raise UsageError(f"manifest exceeds {MAX_SOURCES}-source cap")
    return value, {"path": os.fspath(path), "sha256": digest}


def source_spec(raw: Any, index: int) -> dict[str, Any]:
    where = f"sources[{index}]"
    if not isinstance(raw, dict):
        raise UsageError(f"{where} must be an object")
    path_text = raw.get("path")
    if not isinstance(path_text, str) or not Path(path_text).is_absolute():
        raise UsageError(f"{where}.path must be an absolute string")
    kind = raw.get("kind", "auto")
    if kind not in ("auto", "cli", "native"):
        raise UsageError(f"{where}.kind must be auto, cli, or native")
    boundary = raw.get("native_boundary", "baseline")
    if boundary not in ("baseline", "fresh_session"):
        raise UsageError(f"{where}.native_boundary must be baseline or fresh_session")
    assignment = raw.get("assignment", {})
    if not isinstance(assignment, dict):
        raise UsageError(f"{where}.assignment must be an object")
    phase = assignment.get("phase", "unknown")
    if not isinstance(phase, str) or phase not in PHASES:
        raise UsageError(f"{where}.assignment.phase is not recognized")
    assigned = {"phase": phase}
    for key in ("provider", "model", "effort"):
        assigned[key] = label(assignment.get(key), f"{where}.assignment.{key}")
    return {"path": path_text, "kind": kind, "native_boundary": boundary,
            "assigned": assigned}


def rows(data: bytes, path: str) -> list[tuple[int, dict[str, Any]]]:
    result = []
    for number, raw in enumerate(data.splitlines(), 1):
        if not raw.strip():
            continue
        value = load_json(raw, f"JSONL at {path} line {number}")
        if not isinstance(value, dict):
            raise UsageError(f"line {number}: receipt record must be an object")
        result.append((number, value))
    return result


def nonnegative(value: Any, field: str) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"{field} must be a non-negative integer or null")
    return value


def complete_token_values(values: dict[str, int | None]) -> dict[str, int | None]:
    input_tokens = values["input"]
    cache_read = values["cache_read"]
    cache_write = values["cache_write"]
    if input_tokens is not None and cache_read is not None and cache_read > input_tokens:
        raise ValueError("cached input exceeds input")
    if input_tokens is not None and cache_write is not None and cache_write > input_tokens:
        raise ValueError("cache-write input exceeds input")
    if input_tokens is not None and cache_read is not None and cache_write is not None:
        if cache_read + cache_write > input_tokens:
            raise ValueError("cached and cache-write input exceed input")
        values["uncached_input"] = input_tokens - cache_read - cache_write
    else:
        values["uncached_input"] = None
    if (values["reasoning"] is not None and values["output"] is not None
            and values["reasoning"] > values["output"]):
        raise ValueError("reasoning output exceeds output")
    return values


def token_values(usage: dict[str, Any]) -> dict[str, int | None]:
    mapping = {
        "input": "input_tokens", "cache_read": "cached_input_tokens",
        "cache_write": "cache_write_input_tokens", "output": "output_tokens",
        "reasoning": "reasoning_output_tokens",
    }
    values = {name: nonnegative(usage.get(source), source) for name, source in mapping.items()}
    return complete_token_values(values)


def recorded(provider=None, model=None, effort=None) -> dict[str, str | None]:
    return {"provider": provider, "model": model, "effort": effort}


def observation(source: dict[str, Any], line: int, basis: str, values: dict[str, int | None],
                thread: str | None, turn: str | None, rec: dict[str, Any]) -> dict[str, Any]:
    return {"source": source["path"], "line": line, "basis": basis, "tokens": values,
            "thread_id": thread, "turn_id": turn, "recorded": rec,
            "assigned": source["assigned"]}


def identify_kind(records: list[tuple[int, dict[str, Any]]]) -> str | None:
    cli = any(r.get("type") in ("thread.started", "turn.completed") for _, r in records)
    native = any(r.get("type") == "session_meta" or
                 (r.get("type") == "event_msg" and isinstance(r.get("payload"), dict)
                  and r["payload"].get("type") == "token_count") for _, r in records)
    if cli and native:
        raise UsageError("source mixes recognizable CLI and native shapes")
    if not cli and not native:
        return None
    return "cli" if cli else "native"


def parse_cli(source: dict[str, Any], records: list[tuple[int, dict[str, Any]]]):
    observations, diagnostics = [], []
    threads = {r.get("thread_id") for _, r in records
               if isinstance(r.get("thread_id"), str) and r.get("thread_id")}
    if len(threads) > 1:
        raise UsageError("CLI source contains multiple thread identities")
    thread = next(iter(threads), None)
    starts = sum(row.get("type") == "turn.started" for _, row in records)
    terminals = sum(row.get("type") in ("turn.completed", "turn.failed", "turn.error")
                    for _, row in records)
    if starts > terminals:
        diagnostics.append({"code": "partial_capture", "path": source["path"],
                            "detail": "more turn.started than terminal turn records"})
    seen_turns = {}
    for number, row in records:
        if row.get("type") in ("turn.failed", "turn.error", "error"):
            diagnostics.append({"code": "failed_or_interrupted_turn", "path": source["path"], "line": number})
            if row.get("type") != "error" and not isinstance(row.get("usage"), dict):
                diagnostics.append({"code": "missing_usage", "path": source["path"], "line": number})
            continue
        if row.get("type") != "turn.completed":
            continue
        usage = row.get("usage")
        if not isinstance(usage, dict):
            diagnostics.append({"code": "missing_usage", "path": source["path"], "line": number})
            continue
        try:
            values = token_values(usage)
        except ValueError as exc:
            diagnostics.append({"code": "invalid_observation", "path": source["path"],
                                "line": number, "detail": str(exc)})
            continue
        turn = row.get("turn_id")
        if not isinstance(turn, str):
            turn_obj = row.get("turn")
            turn = turn_obj.get("id") if isinstance(turn_obj, dict) and isinstance(turn_obj.get("id"), str) else None
        rec = recorded(label(row.get("provider"), f"line {number} provider"),
                       label(row.get("model"), f"line {number} model"),
                       label(row.get("effort"), f"line {number} effort"))
        if turn is not None:
            fingerprint = (values, rec)
            if turn in seen_turns:
                if seen_turns[turn] != fingerprint:
                    raise UsageError("conflicting duplicate CLI turn identity")
                diagnostics.append({"code": "duplicate_observation", "path": source["path"], "line": number})
                continue
            seen_turns[turn] = fingerprint
        if row.get("status") in ("failed", "interrupted") or row.get("error") is not None:
            diagnostics.append({"code": "failed_or_interrupted_turn", "path": source["path"], "line": number})
        observations.append(observation(source, number, "incremental", values, thread, turn, rec))
    return observations, diagnostics, thread


def parse_native(source: dict[str, Any], records: list[tuple[int, dict[str, Any]]]):
    observations, diagnostics = [], []
    session_id = None
    meta_line = None
    provider = model = effort = None
    context_epoch = 0
    last_context = None
    counters = []
    starts = terminals = 0
    for number, row in records:
        if row.get("type") == "session_meta":
            payload = row.get("payload")
            if not isinstance(payload, dict) or not isinstance(payload.get("id"), str) or not payload["id"]:
                raise UsageError(f"line {number}: session_meta requires nonempty payload.id")
            if session_id is not None and session_id != payload["id"]:
                raise UsageError("native source contains conflicting session identities")
            session_id, meta_line = payload["id"], number
            provider = label(payload.get("model_provider"), f"line {number} model_provider")
        elif row.get("type") == "turn_context" and isinstance(row.get("payload"), dict):
            payload = row["payload"]
            model = label(payload.get("model"), f"line {number} model")
            effort = label(payload.get("effort") or payload.get("reasoning_effort"), f"line {number} effort")
            current_context = (model, effort)
            if current_context != last_context:
                context_epoch += 1
                last_context = current_context
        elif row.get("type") == "event_msg" and isinstance(row.get("payload"), dict) and row["payload"].get("type") == "task_started":
            starts += 1
        elif row.get("type") == "event_msg" and isinstance(row.get("payload"), dict) and row["payload"].get("type") in ("task_complete", "turn_aborted"):
            terminals += 1
            if row["payload"].get("type") == "turn_aborted":
                diagnostics.append({"code": "failed_or_interrupted_turn", "path": source["path"],
                                    "line": number})
        elif row.get("type") == "event_msg" and isinstance(row.get("payload"), dict) and row["payload"].get("type") == "token_count":
            payload = row["payload"]
            info = payload.get("info")
            total = info.get("total_token_usage") if isinstance(info, dict) else None
            last = info.get("last_token_usage") if isinstance(info, dict) else None
            if not isinstance(total, dict):
                if isinstance(last, dict):
                    diagnostics.append({"code": "latest_context_only", "path": source["path"], "line": number})
                    continue
                diagnostics.append({"code": "missing_usage", "path": source["path"], "line": number})
                continue
            try:
                values = token_values(total)
            except ValueError as exc:
                diagnostics.append({"code": "invalid_observation", "path": source["path"],
                                    "line": number, "detail": str(exc)})
                continue
            counters.append((number, values, recorded(provider, model, effort), context_epoch))
    if starts > terminals:
        diagnostics.append({"code": "partial_capture", "path": source["path"],
                            "detail": "more native task_started than task_complete or turn_aborted markers"})
    if source["native_boundary"] == "fresh_session":
        if not counters or session_id is None or meta_line is None or meta_line >= counters[0][0]:
            raise UsageError("fresh_session requires a preceding same-source session_meta.id")
        diagnostics.append({"code": "fresh_boundary", "path": source["path"], "line": meta_line,
                            "evidence": "caller_assertion + preceding same-source session_meta(id)",
                            "limitation": "does not prove the process was not forked or resumed"})
    previous = None
    previous_epoch = None
    for index, (number, current, rec, epoch) in enumerate(counters):
        if index == 0 and source["native_boundary"] == "fresh_session":
            first_rec = rec
            if epoch > 1:
                first_rec = recorded(provider, None, None)
                diagnostics.append({"code": "context_span", "path": source["path"], "line": number,
                                    "detail": "fresh cumulative total spans recorded context changes"})
            observations.append(observation(source, number, "cumulative_total:fresh_first", current,
                                            session_id, None, first_rec))
        elif previous is None:
            diagnostics.append({"code": "baseline_sample", "path": source["path"], "line": number})
        else:
            regression = any(previous[k] is not None and current[k] is not None and current[k] < previous[k]
                             for k in RAW_FIELDS)
            if regression:
                diagnostics.append({"code": "counter_reset", "path": source["path"], "line": number})
            else:
                delta = {k: (current[k] - previous[k] if current[k] is not None and previous[k] is not None else None)
                         for k in RAW_FIELDS}
                try:
                    complete_token_values(delta)
                except ValueError as exc:
                    diagnostics.append({"code": "invalid_observation", "path": source["path"], "line": number,
                                        "detail": f"invalid cumulative delta: {exc}"})
                else:
                    delta_rec = rec
                    if previous_epoch != epoch:
                        delta_rec = recorded(provider, None, None)
                        diagnostics.append({"code": "context_span", "path": source["path"], "line": number,
                                            "detail": "cumulative delta spans a recorded context change"})
                    observations.append(observation(source, number, "cumulative_delta", delta,
                                                    session_id, None, delta_rec))
        previous = current
        previous_epoch = epoch
    return observations, diagnostics, session_id


def token_object(observations: list[dict[str, Any]], unknown_sources: int = 0) -> dict[str, dict[str, int]]:
    return {field: {"known": sum(o["tokens"][field] for o in observations if o["tokens"][field] is not None),
                    "unknown_observations": unknown_sources + sum(
                        o["tokens"][field] is None for o in observations)}
            for field in FIELDS}


def price(tokens: dict[str, dict[str, int]], rec: dict[str, Any], assigned: dict[str, Any],
          scenario: str, basis: str) -> dict[str, Any]:
    if scenario == "none":
        return {"status": "not_requested", "basis": basis, "usd": None,
                "known_subtotal_usd": None, "components_usd": {}, "reasons": ["pricing_disabled"]}
    route = rec if basis == "recorded" else assigned
    rates = RATES.get((route.get("provider"), route.get("model")))
    status = "priced" if basis == "recorded" else "counterfactual"
    if rates is None:
        return {"status": "unpriced", "basis": basis, "usd": None,
                "known_subtotal_usd": None, "components_usd": {},
                "reasons": ["unknown_provider_or_model_rate"]}
    rate_values = list(map(Decimal, rates))
    if scenario == "standard-long":
        rate_values = [x * 2 for x in rate_values[:3]] + [rate_values[3] * Decimal("1.5")]
    names = ("uncached_input", "cache_read", "cache_write", "output")
    components, reasons = {}, []
    subtotal = Decimal(0)
    for name, rate in zip(names, rate_values):
        cell = tokens[name]
        amount = Decimal(cell["known"]) * rate / Decimal(1_000_000)
        components[name] = format(amount, ".8f")
        subtotal += amount
        if cell["unknown_observations"]:
            reasons.append(f"unknown_{name}")
    complete = not reasons
    return {"status": status if complete else "partial", "basis": basis,
            "usd": format(subtotal, ".8f") if complete else None,
            "known_subtotal_usd": None if complete else format(subtotal, ".8f"),
            "components_usd": components, "reasons": reasons}


def build_report(manifest: dict[str, Any], manifest_info: dict[str, str], pricing: str,
                 price_basis: str, include_observations: bool) -> dict[str, Any]:
    effective, by_path, snapshots, total_size, total_records = [], {}, {}, 0, 0
    for index, raw in enumerate(manifest["sources"]):
        spec = source_spec(raw, index)
        canonical = os.fspath(Path(spec["path"]).resolve())
        if canonical in snapshots:
            digest, recognized, size = snapshots[canonical]
        else:
            try:
                _path, data, digest = read_snapshot(canonical)
            except EvidenceError as exc:
                raise UsageError(str(exc)) from exc
            records = rows(data, canonical)
            recognized = identify_kind(records)
            size = len(data)
            snapshots[canonical] = (digest, recognized, size)
        if spec["kind"] == "auto" and recognized is None:
            raise UsageError("auto kind requires a recognizable CLI or native shape")
        resolved_kind = recognized if spec["kind"] == "auto" else spec["kind"]
        if recognized is not None and spec["kind"] != "auto" and spec["kind"] != recognized:
            raise UsageError("declared source kind does not match recognizable receipt shape")
        spec["kind"] = resolved_kind
        key_labels = json.dumps({"assigned": spec["assigned"], "native_boundary": spec["native_boundary"],
                                 "kind": resolved_kind}, sort_keys=True, separators=(",", ":"))
        if canonical in by_path:
            if by_path[canonical] != key_labels:
                raise UsageError("conflicting duplicate input for the same canonical path")
            continue
        by_path[canonical] = key_labels
        spec["path"] = canonical
        if spec["assigned"]["phase"] == "unknown":
            # Assignment is the only v1 phase source; retain its absence visibly.
            unknown_phase = {"code": "unknown_phase", "path": canonical}
        else:
            unknown_phase = None
        total_size += size
        if total_size > TOTAL_SOURCE_CAP:
            raise UsageError(f"selected receipts exceed {TOTAL_SOURCE_CAP}-byte total cap")
        total_records += len(records)
        if total_records > MAX_RECORDS:
            raise UsageError(f"selected receipts exceed {MAX_RECORDS}-record cap")
        if resolved_kind == "cli":
            observations, diagnostics, identity = parse_cli(spec, records)
        else:
            observations, diagnostics, identity = parse_native(spec, records)
        if unknown_phase is not None:
            diagnostics.append(unknown_phase)
        if not observations:
            diagnostics.append({"code": "source_without_usage", "path": canonical})
        effective.append({"spec": spec, "sha256": digest, "observations": observations,
                          "diagnostics": diagnostics, "identity": identity})
    if len(effective) > 1:
        if any(item["identity"] is None for item in effective):
            raise UsageError("overlap_unknown: multiple sources require known thread identity")
        identities = [item["identity"] for item in effective]
        if len(set(identities)) != len(identities):
            raise UsageError("overlap_refused: a known thread identity appears in distinct sources")

    all_obs = [o for item in effective for o in item["observations"]]
    diagnostics = [d for item in effective for d in item["diagnostics"]]
    if len(effective) == 1 and effective[0]["identity"] is None:
        diagnostics.append({"code": "unknown_identity", "path": effective[0]["spec"]["path"]})
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    missing_by_group: dict[str, int] = defaultdict(int)
    dimensions = {}
    for obs in all_obs:
        dims = {"recorded": obs["recorded"], "assigned": obs["assigned"]}
        key = json.dumps(dims, sort_keys=True, separators=(",", ":"))
        grouped[key].append(obs)
        dimensions[key] = dims
    for item in effective:
        if item["observations"]:
            continue
        dims = {"recorded": recorded(), "assigned": item["spec"]["assigned"]}
        key = json.dumps(dims, sort_keys=True, separators=(",", ":"))
        missing_by_group[key] += 1
        dimensions[key] = dims
        grouped[key]  # Keep a selected-source slice even when no usage was emitted.
    slices = []
    for key in sorted(grouped):
        obs = grouped[key]
        dims = dimensions[key]
        tokens = token_object(obs, missing_by_group[key])
        slice_value = {
            "phase": dims["assigned"]["phase"], "phase_recorded": "unknown",
            "attribution_basis": "manifest.assignment", "recorded": dims["recorded"],
            "assigned": dims["assigned"], "tokens": tokens,
            "price": price(tokens, dims["recorded"], dims["assigned"], pricing, price_basis),
            "provenance": [{"path": o["source"], "sha256": next(i["sha256"] for i in effective if i["spec"]["path"] == o["source"]),
                            "lines": [o["line"]], "basis": o["basis"]} for o in obs],
        }
        slices.append(slice_value)
    hotspots = []
    for index, value in enumerate(slices):
        p = value["price"]
        hotspots.append({"slice": index, "phase": value["phase"],
                         "model": (value[price_basis] if price_basis in value else value["assigned"]).get("model"),
                         "known_price_usd": p["usd"] or p["known_subtotal_usd"],
                         "price_complete": p["usd"] is not None,
                         "known_output_tokens": value["tokens"]["output"]["known"],
                         "known_uncached_input_tokens": value["tokens"]["uncached_input"]["known"],
                         "known_cache_read_tokens": value["tokens"]["cache_read"]["known"],
                         "known_cache_write_tokens": value["tokens"]["cache_write"]["known"]})
    hotspots.sort(key=lambda h: (Decimal(h["known_price_usd"] or "-1"), h["known_output_tokens"],
                                 h["known_uncached_input_tokens"], str(h["phase"]), str(h["model"])), reverse=True)
    tokens = token_object(all_obs, sum(missing_by_group.values()))
    if pricing != "none" and any(s["price"]["status"] in ("unpriced", "partial") for s in slices):
        diagnostics.append({"code": "unpriced_or_partial_cost"})
    incomplete_diagnostics = any(d["code"] in (
        "missing_usage", "invalid_observation", "latest_context_only", "partial_capture",
        "failed_or_interrupted_turn", "baseline_sample", "counter_reset", "context_span",
        "unknown_phase", "source_without_usage", "unpriced_or_partial_cost") for d in diagnostics)
    status = "no_usage" if not all_obs else ("partial" if incomplete_diagnostics or any(
        v["unknown_observations"] for v in tokens.values()) else "complete")
    coverage_reasons = sorted({d["code"] for d in diagnostics if d["code"] not in ("fresh_boundary",)})
    report = {
        "schema": SCHEMA, "manifest": manifest_info,
        "sources": [{"path": i["spec"]["path"], "sha256": i["sha256"], "kind": i["spec"]["kind"],
                     "native_boundary": i["spec"]["native_boundary"], "identity": i["identity"]} for i in effective],
        "scenario": {"name": pricing, "date": RATE_DATE if pricing != "none" else None,
                     "currency": "USD" if pricing != "none" else None},
        "price_basis": price_basis,
        "totals": {"observed_samples": len({(o["source"], o["line"]) for o in all_obs} | {
                       (d.get("path"), d.get("line")) for d in diagnostics
                       if d.get("line") is not None and d["code"] in (
                           "baseline_sample", "latest_context_only", "invalid_observation",
                           "missing_usage", "counter_reset", "duplicate_observation")}),
                   "counted_observations": len(all_obs), "tokens": tokens, "status": status},
        "slices": slices, "hotspots": hotspots,
        "coverage": {"status": status, "baseline_samples": sum(d["code"] == "baseline_sample" for d in diagnostics),
                     "latest_context_only": sum(d["code"] == "latest_context_only" for d in diagnostics),
                     "invalid_observations": sum(d["code"] == "invalid_observation" for d in diagnostics),
                     "missing_usage": sum(d["code"] == "missing_usage" for d in diagnostics),
                     "reasons": coverage_reasons},
        "diagnostics": diagnostics,
        "limitations": ["Selected receipts only; not complete Golden accounting or an invoice.",
                        "Assigned routes are counterfactual labels, not observed execution facts.",
                        "Native cumulative deltas can span multiple contexts; no per-context attribution is inferred."],
    }
    if include_observations:
        report["observations"] = [{"path": o["source"], "line": o["line"], "basis": o["basis"],
                                   "thread_id": o["thread_id"], "turn_id": o["turn_id"],
                                   "tokens": o["tokens"]} for o in all_obs]
    return report


def render_text(report: dict[str, Any]) -> str:
    scenario = report["scenario"]
    dated = (f" @ {scenario['date']} {scenario['currency']}" if scenario["date"] else "")
    lines = [f"Lunacy usage — {scenario['name']}{dated} ({report['price_basis']} basis)",
             f"Coverage: {report['coverage']['status']}; counted {report['totals']['counted_observations']} observation(s)"]
    for rank, hot in enumerate(report["hotspots"], 1):
        value = report["slices"][hot["slice"]]
        tokens = value["tokens"]
        def cell(name):
            item = tokens[name]
            return f"{item['known']}" + (f" + ?x{item['unknown_observations']}" if item["unknown_observations"] else "")
        p = value["price"]
        dollars = p["usd"] or p["known_subtotal_usd"] or "unpriced"
        suffix = "" if p["usd"] else f" ({p['status']}: {','.join(p['reasons'])})"
        recorded_route = f"{value['recorded']['provider'] or '?'}/{value['recorded']['model'] or '?'}@{value['recorded']['effort'] or '?'}"
        assigned_route = f"{value['assigned']['provider'] or '?'}/{value['assigned']['model'] or '?'}@{value['assigned']['effort'] or '?'}"
        components = ", ".join(f"{k}={v}" for k, v in p["components_usd"].items()) or "none"
        lines.append(f"{rank}. {value['phase']} | recorded {recorded_route} | assigned {assigned_route}: "
                     f"input {cell('input')} [uncached {cell('uncached_input')}, read {cell('cache_read')}, write {cell('cache_write')}], "
                     f"output {cell('output')} [reasoning {cell('reasoning')}], USD {dollars}{suffix}; components {components}")
    if not report["hotspots"]:
        lines.append("No countable usage observations.")
    if report["coverage"]["reasons"]:
        lines.append("Coverage notes: " + ", ".join(report["coverage"]["reasons"]))
    lines.append("API-equivalent scenarios are not subscription invoices; only selected receipts are covered.")
    return "\n".join(lines) + "\n"


def main(argv=None) -> int:
    parser = Parser(description=__doc__, add_help=True)
    parser.add_argument("--manifest", required=True, help="absolute lunacy-usage-input-v1 JSON path")
    parser.add_argument("--pricing", choices=("none", "standard-short", "standard-long"), default="none")
    parser.add_argument("--price-basis", choices=("recorded", "assigned"), default="recorded")
    parser.add_argument("--format", choices=("json", "text"), default="json")
    parser.add_argument("--include-observations", action="store_true")
    parser.add_argument("--output-cap", type=int, default=DEFAULT_OUTPUT_CAP)
    try:
        args = parser.parse_args(argv)
        if not 256 <= args.output_cap <= MAX_OUTPUT_CAP:
            raise UsageError(f"--output-cap must be between 256 and {MAX_OUTPUT_CAP}")
        manifest, manifest_info = parse_manifest(args.manifest)
        report = build_report(manifest, manifest_info, args.pricing, args.price_basis,
                              args.include_observations)
        output = (json.dumps(report, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n"
                  if args.format == "json" else render_text(report))
        encoded = output.encode("utf-8")
        if len(encoded) > args.output_cap:
            raise UsageError(f"report exceeds {args.output_cap}-byte output cap")
        sys.stdout.buffer.write(encoded)
        return 0
    except (UsageError, OSError) as exc:
        message = str(exc).replace("\n", "\\n")[:500]
        print(f"usage report refused: {message}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
