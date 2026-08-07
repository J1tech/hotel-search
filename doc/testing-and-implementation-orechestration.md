# Testing & implementation notes

Summary of architecture decisions and how to debug GIATA end-to-end.

See [giata-enrichment.md](./giata-enrichment.md) for full deploy/test reference and [frontend-integration.md](./frontend-integration.md) for FE tasks.

---

## Testing layers

| Layer | Tool | Validates |
|-------|------|-----------|
| A | Postman `POST /hotelDetail` | `giataEnrichment` at response root |
| B | `aws lambda invoke` on `al-rais-giata-svc-dev-enrich` | GIATA service alone |
| C | CloudWatch `hotel-search-dev-hotelDetail` (filter `GIATA`) | Which ID path ran, errors |
| D | `curl` / Postman `GET /imageProxy?imageUrl=...` | GIATA image auth + base64 body |

**If detail has no enrichment:**

```
Postman → CloudWatch (GIATA invoke payload / skipped / failed)
       → aws lambda invoke with same IDs
       → If CLI OK but API not → IAM or env on hotelDetail
```

**If enrichment OK but images broken on page:**

```
Check imageProxy env (GIATA_USERNAME/PASSWORD)
→ curl imageProxy with a giataEnrichment.images[n].url
→ Expect base64 starting with /9j/ (JPEG)
```

---

## Architecture decisions

### Lambda invoke (not public HTTP) for GIATA

- FE calls only `/hotelDetail`.
- Credentials stay in AWS.
- One merged response for the detail page.

### Minimal touch on hotelDetail

- GIATA runs **after** Provesio — fail-safe (no 500).
- Marked with `--- BEGIN/END GIATA ---` in code.
- Booking / retrieve / search untouched.

### ID resolution: cspId preferred

| Path | When |
|------|------|
| `cspId` from FE (listing) | **Preferred** — direct, faster |
| `providerHotelId` + supplier from detail + hotelKey | Fallback — no FE change needed |

Listing has `cspId`; detail usually does not. Backend does not auto-fetch listing — FE must pass `cspId` if using the fast path.

---

## Deploy without full Serverless

Serverless may fail with `aws login` creds. Use code-only scripts:

```bash
npm run push:hotelDetail      # enrichment + logs
npm run push:imageProxy       # image proxy code
npm run set:imageProxy:giata-env  # GIATA creds on imageProxy from SSM
```

IAM for GIATA invoke on shared role is separate (one-time manual step — see main doc).

---

## imageProxy response

Successful curl/GET returns **base64-encoded JPEG** (often starts with `/9j/`). That is correct — not an error.
