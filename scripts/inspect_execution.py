"""
inspect_execution.py — obtiene el detalle de una execution n8n para diagnosticar errores.

Uso:
    set -a; source .env.credentials; set +a
    python scripts/inspect_execution.py <workflow_name_substring> [N]

N: número de executions a inspeccionar (default 2, las más recientes con error).
"""
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]


def load_env():
    env = {}
    f = REPO.parent.parent / "ICClaude" / ".env.credentials"
    for line in f.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def api(env, method, path):
    url = env["N8N_API_URL"].rstrip("/") + path
    req = urllib.request.Request(
        url, method=method,
        headers={"X-N8N-API-KEY": env["N8N_API_KEY"], "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read() or "{}")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:1000]


def main():
    if len(sys.argv) < 2:
        sys.exit("uso: python inspect_execution.py <workflow_name_substring> [N]")
    target = sys.argv[1].lower()
    n = int(sys.argv[2]) if len(sys.argv) > 2 else 2

    env = load_env()
    code, data = api(env, "GET", "/workflows?limit=250")
    wf = next((w for w in data.get("data", []) if target in w.get("name", "").lower()), None)
    if not wf:
        sys.exit(f"workflow no encontrado con substring {target!r}")
    wf_id = wf["id"]
    print(f"Workflow: {wf['name']} (id={wf_id})")
    print()

    code, execs = api(env, "GET", f"/executions?workflowId={wf_id}&limit={n}&includeData=true")
    items = execs.get("data", []) if isinstance(execs, dict) else []
    if not items:
        print("Sin executions.")
        return

    for ex in items[:n]:
        exec_id = ex.get("id")
        print(f"=== Execution {exec_id} ===")
        print(f"  status: {ex.get('status')}")
        print(f"  mode: {ex.get('mode')}")
        print(f"  finished: {ex.get('finished')}")
        print(f"  startedAt: {ex.get('startedAt')}")
        print(f"  stoppedAt: {ex.get('stoppedAt')}")

        # Get with data to see error detail
        code, full = api(env, "GET", f"/executions/{exec_id}?includeData=true")
        if code != 200:
            print(f"  GET con data falló: {code}")
            continue

        data_obj = full.get("data")
        if isinstance(data_obj, str):
            try:
                data_obj = json.loads(data_obj)
            except Exception:
                print(f"  data como string (truncado): {data_obj[:300]}")
                continue

        if not isinstance(data_obj, dict):
            print(f"  data inesperada: type={type(data_obj).__name__}")
            continue

        # Buscar error en data.resultData
        result = data_obj.get("resultData") or {}
        run_data = result.get("runData") or {}
        last_node = result.get("lastNodeExecuted") or "?"
        err = result.get("error")
        print(f"  lastNodeExecuted: {last_node}")
        if err:
            print(f"  ERROR:")
            print(f"    message: {err.get('message')}")
            print(f"    node: {(err.get('node') or {}).get('name', '?')}")
            print(f"    stack (snippet): {str(err.get('stack', ''))[:600]}")
        print(f"  runData nodes: {list(run_data.keys())}")
        # Imprimir error de cada nodo si existe
        for node_name, runs in run_data.items():
            for run in (runs or []):
                e = run.get("error")
                if e:
                    print(f"  -- error en nodo '{node_name}':")
                    print(f"     message: {e.get('message')}")
                    print(f"     description: {e.get('description', '')[:400]}")
        print()


if __name__ == "__main__":
    main()
