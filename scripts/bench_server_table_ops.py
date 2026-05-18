#!/usr/bin/env python3
"""Benchmark server-side table/document mutation hot paths.

This is intentionally lightweight and dependency-free so we can compare before/
after refactors without adding CI cost. Run from the repo root:

    python3 scripts/bench_server_table_ops.py
    python3 scripts/bench_server_table_ops.py --sizes 50x20 200x50 --runs 10
"""

from __future__ import annotations

import argparse
import statistics
import sys
import tempfile
import time
from pathlib import Path
from typing import Callable

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server import document  # noqa: E402
from server.history import History  # noqa: E402


def parse_size(value: str) -> tuple[int, int]:
    try:
        rows, cols = value.lower().split("x", 1)
        parsed = int(rows), int(cols)
    except (TypeError, ValueError):
        raise argparse.ArgumentTypeError("sizes must look like ROWSxCOLS, e.g. 200x50")
    if parsed[0] <= 0 or parsed[1] <= 0:
        raise argparse.ArgumentTypeError("rows and columns must be positive")
    return parsed


def generate_table(rows: int, cols: int) -> str:
    next_id = 1
    parts = ["<!doctype html><html><body>"]
    parts.append(f'<table data-edit-id="e{next_id}"><tbody>')
    next_id += 1
    for r in range(rows):
        parts.append(f'<tr data-edit-id="e{next_id}">')
        next_id += 1
        for c in range(cols):
            parts.append(f'<td data-edit-id="e{next_id}">R{r}C{c}</td>')
            next_id += 1
        parts.append("</tr>")
    parts.append("</tbody></table></body></html>")
    return "".join(parts)


def bench(
    label: str,
    runs: int,
    setup: Callable[[], object],
    fn: Callable[[object], None],
) -> tuple[str, float, float]:
    """Measure fn(ctx), excluding per-run fixture reset/setup time."""
    samples = []
    for _ in range(runs):
        ctx = setup()
        start = time.perf_counter()
        fn(ctx)
        samples.append((time.perf_counter() - start) * 1000)
    return label, statistics.median(samples), max(samples)


def route_like(path: Path, mutate: Callable[[object], object]) -> None:
    soup = document.load_soup(path)
    result = mutate(soup)
    if isinstance(result, tuple) and len(result) == 2 and result[0] is False:
        raise RuntimeError(result[1].get("error", "mutation failed"))
    History(path).remember()
    document.save_soup(path, soup)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sizes", nargs="+", type=parse_size,
                        default=[(50, 20), (200, 50), (500, 50)],
                        help="table sizes like 50x20")
    parser.add_argument("--runs", type=int, default=5)
    parser.add_argument("--updates", type=int, default=500,
                        help="cells to update in save-text-many benchmark")
    args = parser.parse_args()

    print("server table benchmark (median / max ms)")
    print("size,file_kb,operation,median_ms,max_ms")

    with tempfile.TemporaryDirectory(prefix="hce-bench-") as tmp:
        for rows, cols in args.sizes:
            base = Path(tmp) / f"table-{rows}x{cols}.html"
            base.write_text(generate_table(rows, cols), encoding="utf-8")
            file_kb = base.stat().st_size / 1024
            first_cell_id = "e3"  # table=e1, first tr=e2, first td=e3
            update_count = min(args.updates, rows * cols)
            cell_ids = [
                f"e{3 + r * (cols + 1) + c}"
                for r in range(rows)
                for c in range(cols)
            ]
            updates = [
                {"id": edit_id, "text": f"U{i}"}
                for i, edit_id in enumerate(cell_ids[:update_count])
            ]

            original_html = base.read_text(encoding="utf-8")
            run_id = 0

            def fresh_copy(name: str) -> Path:
                nonlocal run_id
                run_id += 1
                path = Path(tmp) / f"{name}-{rows}x{cols}-{run_id}.html"
                path.write_text(original_html, encoding="utf-8")
                return path

            cases: list[tuple[str, Callable[[], object], Callable[[object], None]]] = []
            cases.append(("load_soup", lambda: base, lambda path: document.load_soup(path)))
            cases.append(("parse+save", lambda: Path(tmp) / f"save-{rows}x{cols}.html",
                          lambda out_path: document.save_soup(out_path, document.load_soup(base))))
            cases.append(("row-insert-after", lambda: fresh_copy("row"), lambda path: route_like(
                path,
                lambda soup: document.table_operation(soup, first_cell_id, "row-insert-after"))))
            cases.append(("col-insert-after", lambda: fresh_copy("col"), lambda path: route_like(
                path,
                lambda soup: document.table_operation(soup, first_cell_id, "col-insert-after"))))
            cases.append((f"save-text-many-{update_count}", lambda: fresh_copy("many"), lambda path: route_like(
                path,
                lambda soup: document.update_text_many(soup, updates))))

            for label, setup, fn in cases:
                op, median, worst = bench(label, args.runs, setup, fn)
                print(f"{rows}x{cols},{file_kb:.1f},{op},{median:.1f},{worst:.1f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
