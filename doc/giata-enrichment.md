# GIATA Enrichment on `/hotelDetail`

Reference for Option 3 (thin orchestrator): hotel-search invokes the GIATA enrich Lambda, merges `giataEnrichment` on detail responses, and proxies GIATA image URLs via `imageProxy`.

**Scope:** `POST /hotelDetail` + `GET /imageProxy` only. Search, booking, retrieve unchanged.

---

## Architecture

```
FE
  → POST /hotelDetail { hotelKey, searchKey, culture, cspId? }
      → hotel-search-dev-hotelDetail
          → Provesio POST /hotel/details
          → resolve hotel ID (cspId preferred, else providerHotelId + supplier)
          → Lambda invoke: al-rais-giata-svc-dev-enrich
          → merge giataEnrichment at response root

FE (gallery)
  → GET /imageProxy?imageUrl={giataEnrichment.images[n].url}
      → hotel-search-dev-imageProxy
          → fetch ghgml.giatamedia.com with Basic Auth
          → return base64 JPEG
```

| Service | Lambda | Role |
|---------|--------|------|
| hotel-search | `hotel-search-dev-hotelDetail` | Provesio + GIATA merge |
| hotel-search | `hotel-search-dev-imageProxy` | Proxy GIATA media URLs (Basic Auth) |
| al-rais-giata | `al-rais-giata-svc-dev-enrich` | GIATA images/texts |

**GIATA enrich ARN (dev):**  
`arn:aws:lambda:eu-west-1:648485682397:function:al-rais-giata-svc-dev-enrich`

---

## Code changes

| File | Purpose |
|------|---------|
| `handlers/hotelDetail.js` | ID resolution, `enrichWithGiata()`, GIATA observability logs |
| `handlers/imageProxy.js` | Basic Auth for `giatamedia.com` URLs |
| `lib/giataInvokeClient.js` | Sync invoke of GIATA enrich Lambda |
| `scripts/push-hotelDetail-code.sh` | Code-only deploy: hotelDetail |
| `scripts/push-imageProxy-code.sh` | Code-only deploy: imageProxy |
| `scripts/set-imageProxy-giata-env.sh` | Set GIATA creds on imageProxy from SSM |
| `deploy/serverless-dev.template.yaml` | Tracked Serverless template (GIATA env + IAM + image creds) |
| `deploy/env.example` | Local `.env` template for deploy |

### npm scripts

| Script | What it does |
|--------|----------------|
| `npm run push:hotelDetail` | Upload hotelDetail code only |
| `npm run push:imageProxy` | Upload imageProxy code only |
| `npm run set:imageProxy:giata-env` | Set `GIATA_USERNAME` / `GIATA_PASSWORD` on imageProxy from SSM |

---

## Business logic

### `/hotelDetail`

1. Validates auth, `hotelKey`, `searchKey`, `culture` (`en` | `ar`).
2. Calls Provesio hotel details (unchanged).
3. If `GIATA_ENRICHMENT_ENABLED === "true"`, resolves hotel ID and invokes GIATA.
4. On success, adds **`giataEnrichment`** as sibling of `data` (not inside `data[0]`).
5. On GIATA failure → Provesio-only response (**no 500**).

### Redis

- Redis caches **Provesio-only** (`hotelKey` + `searchKey` + `culture`).
- **GIATA is not cached in Redis** — runs on every request (cache hit or miss).

### Culture → GIATA `include`

| `culture` | GIATA `include` |
|-----------|-----------------|
| `en` | `["images"]` |
| `ar` | `["images", "texts"]` |

Arabic `texts` may be `null` if GIATA has no licensed content (expected).

---

## Hotel ID resolution

Backend builds the GIATA Lambda payload internally — FE does **not** send the GIATA JSON.

### Priority order

| Priority | Source | Notes |
|----------|--------|-------|
| 1 | **`cspId` in request body** | **Recommended** — from listing `propertyInfo.cspId` |
| 2 | `cspId` on detail `data[0]` | Rare |
| 3 | `providerHotelId` + `supplier` | Fallback — works without FE change |

### Listing vs detail

| Field | Listing (`/hotelSearch`) | Detail (`/hotelDetail`) |
|-------|--------------------------|-------------------------|
| `cspId` | `propertyInfo.cspId` | Usually missing |
| `supplier` | `rooms[0].financialInfo.supplier` | Missing — parsed from `hotelKey` |
| `providerHotelId` | `propertyInfo.providerHotelId` | `data[0].providerHotelId` |

### `cspId` ≈ `giataId` (same value)

Listing `cspId: "574397"` → GIATA returns `giataId: "574397"`. Direct `cspId` avoids supplier mapping.

**Latency (verified dev):**

| Path | Example time |
|------|----------------|
| With `cspId` in body | ~617 ms |
| Without `cspId` (mapping fallback) | ~1984 ms |

### Fallback payload (no `cspId`)

```json
{
  "providerHotelId": "681234",
  "supplier": "HOTELBEDS",
  "culture": "en",
  "include": ["images"]
}
```

`supplier` parsed from `hotelKey` (e.g. `...HOTELBEDSHTR...` → `HOTELBEDS`).

---

## Request / response

### `/hotelDetail` — recommended body

```json
{
  "hotelKey": "...",
  "searchKey": "...",
  "culture": "en",
  "cspId": "574397"
}
```

Only add `cspId` when present on listing; omit if missing (backend uses fallback).

Optional fields also accepted: `providerHotelId`, `supplier` (rarely needed).

### Response shape

```json
{
  "data": [{ "providerHotelId": "681234", "images": ["... Provesio ..."] }],
  "giataEnrichment": {
    "giataId": "1067598",
    "name": "Sofitel Dubai The Obelisk",
    "images": [{ "type": "l", "url": "http://ghgml.giatamedia.com/..." }],
    "texts": null
  },
  "sessionId": "..."
}
```

**`giataEnrichment` is at the response root**, not inside `data[0]`.

---

## imageProxy (GIATA images in browser)

GIATA URLs require **Basic Auth**. Browsers cannot call them directly — use `/imageProxy`.

### How it works

1. FE reads `giataEnrichment.images[n].url`.
2. FE requests: `GET /imageProxy?imageUrl={encoded giata url}`.
3. Lambda fetches with `GIATA_USERNAME` / `GIATA_PASSWORD`.
4. Response body = **base64-encoded JPEG** (starts with `/9j/` = success).

### Deploy imageProxy

```bash
aws login
npm run push:imageProxy
npm run set:imageProxy:giata-env
```

Verify Console → `hotel-search-dev-imageProxy` → `GIATA_USERNAME`, `GIATA_PASSWORD`.

SSM paths (same as al-rais-giata service):

- `/al-rais/dev/giata/username`
- `/al-rais/dev/giata/password`

Also wired in `serverless-dev.yaml` / `deploy/serverless-dev.template.yaml` for full Serverless deploy.

### Smoke test

```bash
curl -G "https://hfus5c7uw2.execute-api.eu-west-1.amazonaws.com/dev/imageProxy" \
  --data-urlencode "imageUrl=http://ghgml.giatamedia.com/webservice/rest/1.0/images/574397/8411760"
```

Expect long base64 string (HTTP 200). Save as image:

```bash
curl -G "https://hfus5c7uw2.execute-api.eu-west-1.amazonaws.com/dev/imageProxy" \
  --data-urlencode "imageUrl=http://ghgml.giatamedia.com/webservice/rest/1.0/images/574397/8411760" \
  | base64 -d > /tmp/giata-test.jpg && open /tmp/giata-test.jpg
```

---

## Observability (CloudWatch)

Log group: `/aws/lambda/hotel-search-dev-hotelDetail`

Filter: `GIATA`

| Log message | Meaning |
|-------------|---------|
| `GIATA skipped: GIATA_ENRICHMENT_ENABLED is not true` | Env flag off |
| `GIATA skipped: no hotel ID resolved` | No cspId / providerHotelId / supplier |
| `GIATA invoke payload:` | Exact payload sent to GIATA — proves cspId vs mapping path |
| `GIATA enrichment attached` | Success (`giataId`, image count) |
| `GIATA returned unsuccessful response` | GIATA `success: false` |
| `GIATA enrichment failed` | Invoke threw (IAM, ARN, etc.) |
| `GIATA Lambda FunctionError` | GIATA Lambda error (in giataInvokeClient) |

**Note:** Redeploy hotelDetail after logging changes: `npm run push:hotelDetail`.

---

## Environment variables

### hotelDetail

| Variable | Value |
|----------|-------|
| `GIATA_ENRICHMENT_ENABLED` | `true` (exact string) |
| `GIATA_ENRICH_FUNCTION_ARN` | `arn:aws:lambda:eu-west-1:648485682397:function:al-rais-giata-svc-dev-enrich` |

### imageProxy

| Variable | Source |
|----------|--------|
| `GIATA_USERNAME` | SSM `/al-rais/dev/giata/username` |
| `GIATA_PASSWORD` | SSM `/al-rais/dev/giata/password` |

Ensure Provesio vars (`BASE_URL`, etc.) are real values in Console — not literal SSM paths.

---

## Deployment (code-only — no full Serverless)

### Prerequisites

```bash
aws login
aws sts get-caller-identity
npm install
```

Copy `deploy/env.example` → `.env` for local deploy helpers.

### hotelDetail (enrichment + logs)

```bash
npm run push:hotelDetail
```

### imageProxy (GIATA image auth)

```bash
npm run push:imageProxy
npm run set:imageProxy:giata-env
```

Press **`q`** if AWS CLI opens a pager.

### IAM — GIATA invoke (one-time, if missing)

```bash
aws iam put-role-policy \
  --role-name hotel-search-dev-eu-west-1-lambdaRole \
  --policy-name hotel-search-dev-giata-invoke \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Action": "lambda:InvokeFunction",
      "Resource": "arn:aws:lambda:eu-west-1:648485682397:function:al-rais-giata-svc-dev-enrich"
    }]
  }'
```

Code-only push does **not** update IAM or shared env — use Console or scripts above.

### Full Serverless (optional — use with caution)

Broken SSM resolution can overwrite Console env vars. Prefer code-only push + Console/script for env.

```bash
eval "$(aws configure export-credentials --format env)"
export INTERNAL_BASE_URL=https://yxa1w6bvvd.execute-api.eu-west-1.amazonaws.com
export INTERNAL_SUPPLIER_ROUTING_KEY=dev-internal-supplier-routing-key
npm run deploy:hotelDetail   # or deploy:dev for full stack
```

---

## Testing

### 1. End-to-end detail (with vs without cspId)

**Without cspId** (fallback mapping):

```json
{ "hotelKey": "...", "searchKey": "...", "culture": "en" }
```

**With cspId** (recommended):

```json
{ "hotelKey": "...", "searchKey": "...", "culture": "en", "cspId": "574397" }
```

Postman Tests script:

```javascript
const json = pm.response.json();
const body = JSON.parse(pm.request.body.raw);
console.log({
  sentCspId: body.cspId,
  giataId: json.giataEnrichment?.giataId,
  imageCount: json.giataEnrichment?.images?.length ?? 0,
});
```

Confirm path in CloudWatch: `GIATA invoke payload:` shows `cspId` vs `providerHotelId`.

### 2. GIATA Lambda direct

```bash
aws lambda invoke --region eu-west-1 \
  --function-name al-rais-giata-svc-dev-enrich \
  --cli-binary-format raw-in-base64-out \
  --payload '{"cspId":"1067598","culture":"en","include":["images"]}' \
  /tmp/giata-out.json && cat /tmp/giata-out.json
```

### 3. imageProxy

See smoke test above — expect base64 JPEG body.

---

## Frontend integration

### 1. Pass `cspId` from listing (recommended)

On hotel card click, include listing `propertyInfo.cspId` in `/hotelDetail` body. Omit if absent.

### 2. Images — GIATA first, Provesio fallback

```javascript
const giataImages = response.giataEnrichment?.images ?? [];
const provesioImages = response.data?.[0]?.images ?? [];
const images = giataImages.length > 0 ? giataImages : provesioImages;
```

Display GIATA URLs via `/imageProxy?imageUrl=` (not raw `ghgml.giatamedia.com`).

### 3. EN → AR switch

Refetch `/hotelDetail` with `culture: "ar"`. Use `giataEnrichment.texts` when present; fallback to `data[0].description`.

### 4. Do not call GIATA directly from FE

Single BFF call: `/hotelDetail` returns both Provesio and GIATA data.

---

## Troubleshooting

| Symptom | Likely cause | Fix / log |
|---------|--------------|-----------|
| No `giataEnrichment`, 200 | ID null, env off, IAM, GIATA fail | CloudWatch `GIATA skipped` / `GIATA returned unsuccessful` |
| `GIATA enrichment failed` | IAM / wrong ARN | Add IAM policy; check ARN |
| Images broken on page | imageProxy missing creds | `npm run set:imageProxy:giata-env` |
| imageProxy 403/500 | Creds wrong or URL bad | Check env; curl smoke test |
| curl shows `/9j/4AAQ...` | **Success** — base64 JPEG | FE decodes via proxy URL |
| Booking/retrieve broken | Unrelated to GIATA | Separate Lambdas — not modified |

---

## Q&A

**Do I send the GIATA payload in Postman?**  
No — only `hotelKey`, `searchKey`, `culture`, optional `cspId`.

**Is `cspId` required?**  
No — fallback works. Recommended for speed and simplicity.

**Did GIATA break booking/retrieve?**  
No.

**Why did enrichment fail initially?**  
Wrong ID paths on detail response → code not deployed → missing IAM on enrich invoke.

---

## Verified test hotels (dev)

| Hotel | `cspId` / `giataId` | `providerHotelId` |
|-------|---------------------|-------------------|
| Sofitel Dubai The Obelisk | `1067598` | `681234` |
| (example from cspId test) | `574397` | — |
