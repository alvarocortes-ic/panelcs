"""
cursor.py — manejo del cursor.json compartido entre máquinas vía git.

Estructura:
{
  "zendesk": {
    "tickets_cursor": "<after_cursor del incremental API>",
    "tickets_synced_until_unix": <int>,
    "ticket_events_start_time": <int>,
    "last_fetch_iso": "<ISO>"
  },
  "aircall": {
    "calls_from_unix": <int>,
    "last_fetch_iso": "<ISO>"
  },
  "meta": { "schema_version": 1 }
}

El archivo vive en state/cursor.json (versionado).
Tamaño esperado: <2 KB.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

SCHEMA_VERSION = 1


def cursor_path(base: Path) -> Path:
    return Path(base) / "state" / "cursor.json"


def load(repo_root: Path) -> dict:
    p = cursor_path(repo_root)
    if not p.exists():
        return {
            "zendesk": {},
            "aircall": {},
            "meta": {"schema_version": SCHEMA_VERSION},
        }
    with open(p, encoding="utf-8") as f:
        d = json.load(f)
    d.setdefault("zendesk", {})
    d.setdefault("aircall", {})
    d.setdefault("meta", {}).setdefault("schema_version", SCHEMA_VERSION)
    return d


def save(repo_root: Path, cursor: dict) -> None:
    p = cursor_path(repo_root)
    p.parent.mkdir(parents=True, exist_ok=True)
    cursor.setdefault("meta", {})["schema_version"] = SCHEMA_VERSION
    cursor["meta"]["last_save_iso"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    with open(p, "w", encoding="utf-8") as f:
        json.dump(cursor, f, indent=2, ensure_ascii=False)


def zd_get(cursor: dict, key: str, default=None):
    return cursor.get("zendesk", {}).get(key, default)


def zd_set(cursor: dict, key: str, value) -> None:
    cursor.setdefault("zendesk", {})[key] = value


def ac_get(cursor: dict, key: str, default=None):
    return cursor.get("aircall", {}).get(key, default)


def ac_set(cursor: dict, key: str, value) -> None:
    cursor.setdefault("aircall", {})[key] = value


def stamp_fetch(cursor: dict, source: str) -> None:
    """Marca timestamp del último fetch de la fuente."""
    iso = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    cursor.setdefault(source, {})["last_fetch_iso"] = iso
