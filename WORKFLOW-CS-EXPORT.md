# Workflow n8n `cs-export` — Exportador de tickets por rango para análisis IA

> [!success] Estado 2026-05-29 (SES-20260529-0728): **IMPLEMENTADO y validado en `_test`** (`CS Export _test` `I2BNaChz4jp9ZwY1`). Falta solo **portar a prod** (`VDRQnxqBumKPfiyC`), parte de la fase A con GO de Alvaro.
>
> **La arquitectura real difiere del diseño original de abajo** (que asumía Zendesk Search + show_many). Arquitectura implementada (Enfoque C del panel de diseño — ver `n8n/DESIGN-B-FINAL.json` + `HANDOFF-PENDIENTES.md` callout success):
> - **Tickets + métricas enriquecidas** ← MongoDB `PanelCSTickets` (find por `organizationId` + `createdAtUnix` rango). Elimina el límite de 1000 del Search y reusa el enrich de CS Data v2.
> - **tags + description + nombres (agent/group/org) + rut** ← Zendesk `show_many` (`include=users,groups,organizations`, batches de 100). El rut sale de `organization_fields.rut`.
> - **comments + author{id,name,role}** ← Zendesk `/tickets/{id}/comments.json?include=users`.
> - **Auth por credencial n8n** (`Zendesk Prod` + `Mongo Atlas devqa - Panel CS`) — sin token hardcoded (fase D resuelta).
> - Output JSONL binary igual (front sin cambios). Validación + rama de error → `_meta.ok:false` JSONL. cap `MAX_TICKETS=800`.
> - Perf medida: 284 tickets / 30d en **20.6s**. Campo `description` agregado (extra sobre la spec).
>
> Implementación reproducible: `outputs/cs-panel/scripts/apply_cs_export_b.py [--prod] [--apply]`.
>
> El frontend ya estaba implementado en `cs-view.render.js`.

## Propósito

Endpoint webhook que recibe `org_id + from + to` y devuelve un archivo `.jsonl` con todos los tickets del cliente en el rango, enriquecidos con metadata + métricas + **comments completos** (descripción + respuestas) traídos fresh desde Zendesk. Diseñado para alimentar a Gemini / Claude con casuísticas de tickets.

## Endpoint

`GET https://prod-low-code.iconstruye.dev/webhook/cs-export`

**Query params**:
- `org` — `organization_id` del cliente Zendesk (required)
- `from` — `YYYY-MM-DD` fecha de apertura inclusive (required)
- `to` — `YYYY-MM-DD` fecha de apertura inclusive (required)

**Validaciones**:
- Rango `to - from <= 93 días` (3 meses). Si excede → HTTP 400 con `{"error":"range_exceeded","max_days":93}`.
- `org`, `from`, `to` requeridos → HTTP 400 si faltan.

**Response**:
- 200 OK con `Content-Type: application/x-ndjson` y `Content-Disposition: attachment; filename="cs-export-<org>-<from>_<to>.jsonl"`.
- 1 línea = 1 ticket en formato JSON.

## Estructura de cada línea JSONL

```json
{
  "id": 1812947,
  "subject": "Falla integración OC con Comprasys",
  "status": "solved",
  "priority": "high",
  "type": "incident",
  "created_at": "2026-05-01T14:32:11Z",
  "updated_at": "2026-05-12T09:00:00Z",
  "solved_at": "2026-05-12T09:00:00Z",
  "frt_min": 47,
  "reopens": 0,
  "sla_breached": false,
  "csat": null,
  "agent": { "id": 12345, "name": "María González" },
  "group": { "id": 67890, "name": "SN1 General" },
  "organization": { "id": 555, "name": "Vital S.A.", "rut": "76.123.456-7" },
  "category": "Integraciones",
  "product": "Compra (OC)",
  "subproduct": "Comprasys",
  "linea_negocio": "Suministros",
  "via_channel": "email",
  "canal_normalizado": "Correo",
  "escalamientos": { "paso_sn1": true, "esc_sn2": false, "esc_mo": false, "devol": 0 },
  "tags": ["integracion","comprasys","oc"],
  "comments": [
    {
      "id": 9001,
      "author": { "id": 999, "name": "Cliente Vital", "role": "end-user" },
      "created_at": "2026-05-01T14:32:11Z",
      "body": "Buenos días, llevamos 3 días con error al enviar OCs a Comprasys. ¿Pueden revisar?",
      "public": true
    },
    {
      "id": 9002,
      "author": { "id": 12345, "name": "María González", "role": "agent" },
      "created_at": "2026-05-01T15:19:00Z",
      "body": "Hola, revisando logs del worker. Los identifico abajo:\n\n- 14:30 OC #4521 → 500\n...",
      "public": true
    }
  ]
}
```

## Arquitectura del workflow

```mermaid
flowchart TD
    A[Webhook GET /cs-export] --> B[Validar query params]
    B -->|inválido| Z[Respond 400 JSON]
    B -->|ok| C[Set: zd_url, zd_auth, query]
    C --> D[HTTP Zendesk: tickets/search.json?query=organization:X created>=from created<=to]
    D -->|loop pages| D
    D --> E[Function: tickets[] + ids[]]
    E --> F[HTTP Zendesk: GET /api/v2/tickets/show_many.json?ids=...&include=users,groups,organizations]
    F --> G[Function: enriquecer cada ticket con users/groups/orgs lookup]
    G --> H[HTTP Zendesk loop: GET /api/v2/tickets/{id}/comments.json]
    H -->|n veces| H
    H --> I[Function: ensamblar JSONL final]
    I --> J[Respond: Content-Type x-ndjson, Content-Disposition attachment]
    B -.->|on error| K[Log a workflow CS Errores]
    D -.->|on error| K
    F -.->|on error| K
    H -.->|on error| K
    K --> L[Respond 500 JSON con sugerencia 'levantar con Aldo']
```

## Nodos (especificación)

1. **Webhook** `cs-export` (GET) — entry point.
2. **Function "Validar"** — parsea query, valida rango ≤ 93 días, devuelve error temprano si falla.
3. **HTTP Request "Zendesk Search"** — paginación de `tickets/search.json`. Header `Authorization: Bearer {{ $env.ZENDESK_TOKEN }}`.
4. **Function "Recolectar IDs"** — junta todos los `id` de los tickets paginados.
5. **HTTP Request "Show Many"** — `GET tickets/show_many.json?ids=1,2,3&include=users,groups,organizations` (batches de 100).
6. **Function "Enriquecer"** — mapea users/groups/orgs lookup + extrae custom fields (categoria, producto, etc.).
7. **HTTP Request loop "Comments"** — `GET tickets/{id}/comments.json` por cada ticket. **Limitar concurrencia a 3** para no saturar API.
8. **Function "Ensamblar JSONL"** — construye string `tickets.map(t => JSON.stringify(t)).join('\n')`.
9. **Respond to Webhook** — `Content-Type: application/x-ndjson`, `Content-Disposition: attachment; filename="..."`.
10. **Error Trigger** → invoca workflow `o89xKbjT6mKkjAmN` (CS Errores) con contexto (org, from, to, error message, stack).

## Performance esperado

- Rango chico (1 mes, 50 tickets): ~5-10s.
- Rango medio (2 meses, 200 tickets): ~20-40s.
- Rango grande (3 meses, 500 tickets): ~60-120s (cerca del límite del webhook timeout n8n).

Si el rango supera el timeout en práctica, plan B: implementar export asíncrono con polling (`POST` retorna `job_id`, `GET /cs-export-status?job=X` da el archivo cuando listo). Solo si el caso aparece.

## Setup

El script `outputs/cs-panel/scripts/setup_cs_export.py` (a crear) levanta este workflow vía n8n API. NO se deploya automáticamente — requiere autorización explícita del usuario.

## Cross-link

- Frontend: `outputs/cs-panel/n8n/cs-view.render.js` funciones `buildOrgExportador()`, `expExportar()`, `showToast()`.
- Workflow CS Errores: `o89xKbjT6mKkjAmN` (ya existe, capturará logs de error).
- Pendiente: crear `setup_cs_export.py` con el JSON del workflow + deploy via API.
