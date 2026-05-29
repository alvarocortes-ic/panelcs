"""Probe estabilidad n8n productivo — 5 rondas por endpoint, separadas 1.2s.
Útil antes de un deploy para confirmar que el runtime no oscila."""
import os, sys, time, urllib.request, urllib.error

base = (os.environ.get("N8N_API_URL") or os.environ.get("N8N_BASE_URL", "")).rstrip("/")
key  = os.environ.get("N8N_API_KEY", "")
if not base or not key:
    sys.exit("ERROR: faltan N8N_API_URL/N8N_API_KEY en el entorno (source .env.credentials)")

host = base.replace("/api/v1", "")

def probe(url, headers=None, timeout=30):
    t = time.time()
    req = urllib.request.Request(url, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, len(r.read()), time.time() - t
    except urllib.error.HTTPError as e:
        return e.code, 0, time.time() - t
    except Exception:
        return None, 0, time.time() - t

ROUNDS = 5
targets = [
    ("cs-view",  host + "/webhook/cs-view",   {}),
    ("cs-seed",  host + "/webhook/cs-seed",   {}),
    ("api/wf",   base + "/workflows?limit=1", {"X-N8N-API-KEY": key, "Accept": "application/json"}),
    ("healthz",  host + "/healthz",           {}),
]

print(f"{'target':<10} " + " ".join(f"r{i+1:>2}".rjust(6) for i in range(ROUNDS)) + "    veredicto")
print("-" * 72)
all_stable = True
for label, url, hdrs in targets:
    results = []
    for _ in range(ROUNDS):
        code, _sz, _el = probe(url, hdrs, timeout=30)
        results.append(code)
        time.sleep(1.2)
    okN = sum(1 for c in results if c == 200)
    veredicto = "ESTABLE OK" if okN == ROUNDS else f"oscilando ({okN}/{ROUNDS} ok)"
    if okN != ROUNDS:
        all_stable = False
    print(f"{label:<10} " + " ".join(f"{str(c or 'ERR'):>6}" for c in results) + f"    {veredicto}")

print()
print("VEREDICTO GLOBAL:", "DEPLOY OK" if all_stable else "NO DEPLOY (inestabilidad detectada)")
sys.exit(0 if all_stable else 1)
