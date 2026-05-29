"""
raw_cache.py — utilidades de cache append-only en jsonl.gz, particionado por mes.

Diseño:
- Cada partición vive en `<root>/<source>/<kind>/YYYY-MM.jsonl.gz`.
- Append-only: cada línea es un JSON con su timestamp; al leer se dedupa por
  `key_fn(item)` quedándose con el último (mayor timestamp).
- Los meses cerrados son inmutables en la práctica — al rehidratar un ticket
  viejo se appendeará al mes en curso, no al original (el dedup lo une igual).
"""

from __future__ import annotations

import gzip
import io
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Iterable, Iterator


def month_partition(iso_ts: str | None, now: datetime | None = None) -> str:
    """Devuelve 'YYYY-MM' a partir de un timestamp ISO. Si viene None, usa now."""
    if iso_ts:
        try:
            return iso_ts[:7]
        except Exception:
            pass
    n = now or datetime.now(timezone.utc)
    return n.strftime("%Y-%m")


def partition_path(root: Path, source: str, kind: str, month: str) -> Path:
    return Path(root) / source / kind / f"{month}.jsonl.gz"


def append_records(
    root: Path,
    source: str,
    kind: str,
    records: Iterable[dict],
    partition_by: Callable[[dict], str],
) -> dict[str, int]:
    """Appendea records a la(s) partición(es) correspondiente(s).

    `partition_by(record)` retorna 'YYYY-MM'. Records con la misma partición se
    appendean al mismo archivo en una sola apertura.
    """
    buckets: dict[str, list[dict]] = {}
    for r in records:
        buckets.setdefault(partition_by(r), []).append(r)

    counts: dict[str, int] = {}
    for month, items in buckets.items():
        p = partition_path(root, source, kind, month)
        p.parent.mkdir(parents=True, exist_ok=True)
        # gzip append "concatenando streams" es válido: gzip soporta multi-member
        # files. Cada bloque escrito es un member independiente.
        with gzip.open(p, "ab") as gz:
            for r in items:
                gz.write((json.dumps(r, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8"))
        counts[month] = counts.get(month, 0) + len(items)
    return counts


def iter_records(root: Path, source: str, kind: str, months: list[str] | None = None) -> Iterator[dict]:
    """Itera todas las líneas de las particiones, en orden por mes ascendente.

    Si `months` es None, itera todas las particiones del kind.
    """
    base = Path(root) / source / kind
    if not base.exists():
        return
    files = sorted(base.glob("*.jsonl.gz"))
    if months is not None:
        wanted = set(months)
        files = [f for f in files if f.stem.replace(".jsonl", "") in wanted]
    for f in files:
        with gzip.open(f, "rb") as gz:
            for line in gz:
                line = line.strip()
                if not line:
                    continue
                try:
                    yield json.loads(line)
                except json.JSONDecodeError:
                    # línea corrupta — saltar (no abortar)
                    continue


def dedup_last(
    records: Iterable[dict],
    key_fn: Callable[[dict], object],
    ts_fn: Callable[[dict], str],
) -> dict[object, dict]:
    """Reduce records al último por `key_fn`, comparando por `ts_fn` (ISO string)."""
    out: dict[object, dict] = {}
    for r in records:
        k = key_fn(r)
        if k is None:
            continue
        ts = ts_fn(r) or ""
        prev = out.get(k)
        if prev is None or (ts_fn(prev) or "") <= ts:
            out[k] = r
    return out


def list_partitions(root: Path, source: str, kind: str) -> list[str]:
    """Devuelve los meses ('YYYY-MM') existentes en el cache, ordenados."""
    base = Path(root) / source / kind
    if not base.exists():
        return []
    return sorted(f.stem.replace(".jsonl", "") for f in base.glob("*.jsonl.gz"))


def partition_size_bytes(root: Path, source: str, kind: str, month: str) -> int:
    p = partition_path(root, source, kind, month)
    return p.stat().st_size if p.exists() else 0


def stats(root: Path, source: str, kind: str) -> dict:
    """Resumen rápido del cache de una fuente/kind."""
    months = list_partitions(root, source, kind)
    total_size = sum(partition_size_bytes(root, source, kind, m) for m in months)
    total_records = 0
    for _ in iter_records(root, source, kind):
        total_records += 1
    return {
        "source": source,
        "kind": kind,
        "months": months,
        "total_records": total_records,
        "total_bytes": total_size,
    }
