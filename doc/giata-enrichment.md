# GIATA Enrichment on `/hotelDetail`

Reference for the Option 3 (thin orchestrator) integration: hotel-search invokes the deployed GIATA enrich Lambda and merges `giataEnrichment` onto the hotel detail response.

**Scope:** `POST /hotelDetail` only (`hotel-search-dev-hotelDetail`). Search, booking, retrieve, and other endpoints are unchanged.

---

## Architecture

```
FE / Postman
  → POST /hotelDetail { hotelKey, searchKey, culture }
      → hotel-search-dev-hotelDetail
          → Provesio POST /hotel/details
          → build GIATA payload from detail response + hotelKey
          → Lambda invoke: al-rais-giata-svc-dev-enrich
              → (inside GIATA service) GHGML HTTP/XML API
          → merge giataEnrichment at response root
```

| Service | Function | Role |
|---------|----------|------|
| hotel-search | `hotel-search-dev-hotelDetail` | Orchestrator — Provesio + GIATA merge |
| al-rais-giata | `al-rais-giata-svc-dev-enrich` | Fetch GIATA images/texts |

**GIATA enrich Lambda ARN (dev):**  
`arn:aws:lambda:eu-west-1:648485682397:function:al-rais-giata-svc-dev-enrich`

---

## Code changes

| File | Purpose |
|------|---------|
| `handlers/hotelDetail.js` | ID resolution, `enrichWithGiata()`, cache hit + miss |
| `lib/giataInvokeClient.js` | Sync invoke of GIATA enrich Lambda |
| `scripts/push-hotelDetail-code.sh` | Deploy hotelDetail code without full Serverless |
| `deploy/serverless-dev.template.yaml` | Tracked Serverless template (GIATA env + IAM) |
| `deploy/giata-serverless-snippet.yaml` | GIATA env/IAM snippet reference |

---

## Business logic

### What the API does

1. Validates auth, `hotelKey`, `searchKey`, `culture` (`en` | `ar`).
2. Calls Provesio hotel details (unchanged).
3. If `GIATA_ENRICHMENT_ENABLED === "true"`, resolves a hotel ID and invokes GIATA.
4. On success, adds **`giataEnrichment`** as a **sibling of `data`** (not inside `data[0]`).
5. On GIATA failure, returns Provesio-only — **no 500** (fail-safe).

### Who picks images for the UI?

**Frontend.** Backend returns both sources:

- `giataEnrichment.images` — GIATA
- `data[0].images` — Provesio / Hotelbeds

FE rule: use GIATA when `giataEnrichment.images?.length > 0`, else Provesio.

### Redis cache

- Redis stores **Provesio-only** (unchanged cache key: `hotelKey` + `searchKey` + `culture`).
- **GIATA is not cached in Redis.**
- GIATA runs on **every** response (cache hit and cache miss), then `giataEnrichment` is attached at return time only.

### Culture → GIATA `include`

| `culture` | GIATA `include` |
|-----------|-----------------|
| `en` | `["images"]` |
| `ar` | `["images", "texts"]` |

Arabic texts may be `null` if GIATA has no licensed content (expected).

---

## How hotel IDs are resolved

hotel-search does **not** call GIATA HTTP directly. It builds a JSON payload and invokes the GIATA Lambda.

### Priority order

| Priority | Source | Notes |
|----------|--------|-------|
| 1 | `cspId` in **request body** | Optional — FE can pass from listing |
| 2 | `cspId` on detail `data[0]` | Rare — detail usually has no `cspId` |
| 3 | `providerHotelId` + `supplier` | **Primary path for current dev flow** |

### Listing vs detail (important)

| Field | Hotel search (listing) | Hotel detail |
|-------|------------------------|--------------|
| `cspId` | Often in `propertyInfo.cspId` | Usually **missing** |
| `supplier` | On `rooms[0].financialInfo.supplier` | Usually **missing** |
| `providerHotelId` | In `propertyInfo` | On **`data[0]` root** (e.g. `"681234"`) |

**Current production flow (no `cspId` required):**

- `providerHotelId` — from **detail** response (`data[0].providerHotelId`)
- `supplier` — parsed from **`hotelKey`** (e.g. `...HOTELBEDSHTR...` → `HOTELBEDS`)

Example internal payload (built by backend, **not** sent by Postman):

```json
{
  "providerHotelId": "681234",
  "supplier": "HOTELBEDS",
  "culture": "en",
  "include": ["images"]
}
```

GIATA maps `681234 + HOTELBEDS` → `giataId: "1067598"` and returns images. That becomes `giataEnrichment.giataId`.

### Optional `cspId`

Not required if `providerHotelId` + supplier mapping works. Code still accepts optional `cspId` in the request body as a fallback if FE passes it from the listing card.

---

## Response shape

```json
{
  "meta": { ... },
  "commonData": { ... },
  "data": [
    {
      "hotelKey": "...",
      "providerHotelId": "681234",
      "name": "Sofitel Dubai The Obelisk",
      "images": [ "... Provesio/Hotelbeds images ..." ]
    }
  ],
  "giataEnrichment": {
    "giataId": "1067598",
    "name": "Sofitel Dubai The Obelisk",
    "city": "Dubai",
    "country": "AE",
    "images": [ { "type": "l", "url": "http://ghgml.giatamedia.com/..." } ],
    "texts": null
  },
  "sessionId": "..."
}
```

Search for **`giataEnrichment` at the root**, not inside `data[0]`.

---

## Q&A (clarifications from implementation)

### Do I pass the GIATA payload in Postman?

**No.** You only send:

```json
{
  "hotelKey": "...",
  "searchKey": "...",
  "culture": "en"
}
```

hotel-search builds the GIATA Lambda payload internally after Provesio returns.

### Is `cspId` required?

**No** for the current flow. Detail gives `providerHotelId`; supplier comes from `hotelKey`. Listing `cspId` is not used unless FE optionally passes it in the detail request body.

### Where does `giataId` in the response come from?

From the **GIATA enrich Lambda response**, after it maps `providerHotelId + supplier` (or `cspId`) to a GIATA property.

### Does Redis cache GIATA images?

**No.** Only Provesio detail is cached. GIATA is invoked on every request.

### Did GIATA changes break hotel booking or retrieve?

**No.** Only `hotel-search-dev-hotelDetail` was changed. `hotelBooking` and `hotelRetrieve` are separate Lambdas and were not modified.

### Why did enrichment fail initially?

Three stacked issues:

1. **Wrong ID paths** — code looked for listing-shaped fields (`propertyInfo.cspId`, `rooms[0].supplier`) on detail response → silent skip.
2. **Code not deployed** — fix was local until `npm run push:hotelDetail`.
3. **Missing IAM** — Lambda role had no `lambda:InvokeFunction` on GIATA enrich (Serverless full deploy never applied IAM; code-only push does not update IAM).

---

## Environment variables (hotelDetail Lambda)

Set in AWS Console on `hotel-search-dev-hotelDetail`:

| Variable | Example value |
|----------|----------------|
| `GIATA_ENRICHMENT_ENABLED` | `true` (exact string) |
| `GIATA_ENRICH_FUNCTION_ARN` | `arn:aws:lambda:eu-west-1:648485682397:function:al-rais-giata-svc-dev-enrich` |

Also ensure Provesio vars are real URLs/values (not unresolved SSM path literals like `/provesio/baseurl~true`).

---

## Deployment

### Prerequisites

- AWS CLI logged in: `aws login` then `aws sts get-caller-identity`
- `.env` in repo root (see `deploy/env.example`)
- `npm install` (includes `@aws-sdk/client-lambda`)

### Option A — Code only (recommended when Serverless creds fail)

Uses `scripts/push-hotelDetail-code.sh`. Updates **code only** — does not change env vars or IAM.

```bash
aws login
npm run push:hotelDetail
```

If AWS CLI opens a pager (`:` at bottom), press **`q`** to exit.

### Option B — Serverless function deploy

Requires Serverless to see AWS credentials. `aws login` alone may not work; export creds first:

```bash
aws login
eval "$(aws configure export-credentials --format env)"
export INTERNAL_BASE_URL=https://yxa1w6bvvd.execute-api.eu-west-1.amazonaws.com
export INTERNAL_SUPPLIER_ROUTING_KEY=dev-internal-supplier-routing-key
npm run deploy:hotelDetail
```

**Warning:** Full Serverless deploy with broken SSM resolution can overwrite Console env vars with literal SSM paths. Prefer Console for env fixes or fix `serverless-dev.yaml` before full deploy.

### IAM — required once (manual)

The shared Lambda role needs permission to invoke GIATA. Add if missing:

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

Code-only deploy (`push:hotelDetail`) does **not** apply this — it must exist on the role separately.

---

## Testing

### 1. Hotel detail API (end-to-end)

```bash
curl -X POST 'https://hfus5c7uw2.execute-api.eu-west-1.amazonaws.com/dev/hotelDetail' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -d '{
    "hotelKey": "cd23ca3a-8f39-440b-b684-1b933fb69e93HOTELBEDSHTR00000000",
    "searchKey": "cd23ca3a-8f39-440b-b684-1b933fb69e93",
    "culture": "en"
  }'
```

Expect `giataEnrichment` at the response root with ~19 GIATA images for Sofitel (giataId `1067598`).

### 2. GIATA Lambda directly (simulates what hotel-search invokes)

By `cspId`:

```bash
aws lambda invoke \
  --region eu-west-1 \
  --function-name al-rais-giata-svc-dev-enrich \
  --cli-binary-format raw-in-base64-out \
  --payload '{"cspId":"1067598","culture":"en","include":["images"]}' \
  /tmp/giata-out.json && cat /tmp/giata-out.json
```

By `providerHotelId` + `supplier` (same as detail flow):

```bash
aws lambda invoke \
  --region eu-west-1 \
  --function-name al-rais-giata-svc-dev-enrich \
  --cli-binary-format raw-in-base64-out \
  --payload '{"providerHotelId":"681234","supplier":"HOTELBEDS","culture":"en","include":["images"]}' \
  /tmp/giata-out.json && cat /tmp/giata-out.json
```

### Postman Tests script

```javascript
const json = pm.response.json();
console.log({
  providerHotelId: json.data?.[0]?.providerHotelId,
  giataEnrichment: json.giataEnrichment,
  giataImages: json.giataEnrichment?.images?.length ?? 0,
  giataId: json.giataEnrichment?.giataId,
});
```

---

## Troubleshooting

| Symptom | Likely cause | CloudWatch log to search |
|---------|----------------|-------------------------|
| No `giataEnrichment`, 200 OK | ID payload null, env off, IAM, or GIATA `success: false` | `GIATA skipped`, `GIATA returned unsuccessful` |
| `GIATA enrichment failed` | IAM denied, wrong ARN, Lambda error | `GIATA enrichment failed`, `GIATA Lambda FunctionError` |
| Provesio works, GIATA silent | Invoke blocked or ID not resolved | `GIATA skipped: no hotel ID resolved` |
| Enrichment disabled | Env not `"true"` | `GIATA skipped: GIATA_ENRICHMENT_ENABLED is not true` |
| Success | — | `GIATA enrichment attached` |
| `Invalid URL` in logs | `BASE_URL` env is literal SSM path — fix in Console |
| Serverless deploy fails creds | Use `eval "$(aws configure export-credentials --format env)"` or `npm run push:hotelDetail` |

**CloudWatch log groups:**

- `/aws/lambda/hotel-search-dev-hotelDetail`
- `/aws/lambda/al-rais-giata-svc-dev-enrich`

---

## imageProxy (GIATA image URLs)

GIATA image URLs (`ghgml.giatamedia.com`) require **Basic Auth**. `handlers/imageProxy.js` adds auth when `GIATA_USERNAME` / `GIATA_PASSWORD` are set on the Lambda.

### Deploy imageProxy (code + env, no full serverless)

```bash
aws login

# 1. Push latest imageProxy code
npm run push:imageProxy

# 2. Set GIATA creds from SSM on the Lambda (required for GIATA URLs)
npm run set:imageProxy:giata-env
```

Verify in Console → `hotel-search-dev-imageProxy` → Environment variables: `GIATA_USERNAME`, `GIATA_PASSWORD`.

### Smoke test

```
GET https://hfus5c7uw2.execute-api.eu-west-1.amazonaws.com/dev/imageProxy?imageUrl=http://ghgml.giatamedia.com/webservice/rest/1.0/images/574397/8411760
```

Expect **200** + base64 body (not 403/500).

---

## Frontend follow-up (optional)

1. Pass `culture` on detail requests.
2. Prefer `giataEnrichment.images`; fallback to `data[0].images`.
3. Optionally pass `cspId` from listing into `/hotelDetail` body for hotels where supplier mapping fails.

---

## Verified test hotel (dev)

| Field | Value |
|-------|-------|
| Hotel | Sofitel Dubai The Obelisk |
| `hotelKey` | `cd23ca3a-8f39-440b-b684-1b933fb69e93HOTELBEDSHTR00000000` |
| `searchKey` | `cd23ca3a-8f39-440b-b684-1b933fb69e93` |
| `providerHotelId` | `681234` |
| GIATA `giataId` | `1067598` |
