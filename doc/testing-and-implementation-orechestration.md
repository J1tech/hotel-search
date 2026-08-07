

1. **Testing internal calls** — use 3 layers (Postman E2E + direct GIATA invoke + CloudWatch).
2. **Lambda invoke vs HTTP** — what you did is the **right** approach; don’t expose GIATA HTTP to FE.
3. **Touching detail API** — you had to touch **some** backend orchestrator; you did the **minimal, safest** version.

---

## 1. How to test / debug when something breaks internally

Postman only sees the **final** `/hotelDetail` response. Internal GIATA calls need **layered** testing:

| Layer | What | When to use |
|-------|------|-------------|
| **A. Postman** | `POST /hotelDetail` → check root `giataEnrichment` | End-to-end — “does the user get GIATA?” |
| **B. AWS CLI** | `aws lambda invoke` on `al-rais-giata-svc-dev-enrich` | Is GIATA service itself OK? (you already did this) |
| **C. CloudWatch** | Logs for `hotel-search-dev-hotelDetail` and `al-rais-giata-svc-dev-enrich` | When A fails but B works → orchestration/IAM/ID mapping |

**If `/hotelDetail` has no `giataEnrichment`:**

```
Postman fails
  → Check hotelDetail CloudWatch: "GIATA enrichment failed" or no invoke
  → Run aws lambda invoke with same payload (681234 + HOTELBEDS)
  → If CLI works but API doesn't → IAM, env vars, or ID build logic
  → If CLI fails → GIATA service / mapping issue
```

That’s the same idea as Postman, just **one level deeper** for internal calls. You don’t need a public HTTP URL for GIATA to debug it.

---

## 2. Should you expose GIATA as HTTP?

**No — keep it as Lambda invoke. That’s optimal for your setup.**

| Approach | Verdict |
|----------|---------|
| **Current: hotel-search invokes GIATA Lambda** | Best — matches Option 3 design, GIATA stays internal, one FE call, credentials stay in AWS |
| **Expose GIATA as public HTTP** | Worse — extra API Gateway, auth, CORS, more to secure and maintain |
| **FE calls GIATA directly** | Bad — FE would need mapping logic, extra round trip, no merged response |

**FE should only call `/hotelDetail`.** GIATA is a **backend-internal** service, not a public API. Postman on `/hotelDetail` is the correct external test surface.

---

## 3. Did you have to touch someone else’s detail API?

**You had to touch some backend** to merge GIATA into the detail response. There’s no way for FE alone to get `giataEnrichment` inside the same `/hotelDetail` payload without backend changes.

**What you actually changed (minimal & safe):**

- Added GIATA **after** existing Provesio flow — auth, validation, cache, Provesio call **unchanged**
- GIATA is **fail-safe** — if it fails, users still get the same Provesio detail as before
- Only **`hotelDetail`** touched — not booking, retrieve, search
- New code is clearly marked (`--- BEGIN/END GIATA ---`) in `handlers/hotelDetail.js`

**Alternatives (and why they’re worse):**

| Alternative | Problem |
|-------------|---------|
| FE calls GIATA separately | Two API calls, mapping on FE, worse UX |
| New `/hotelDetailWithGiata` endpoint | Duplicates detail logic |
| Proxy/middleware only | Still backend work, more complex |

**Touching `hotelDetail` as the BFF orchestrator is the standard pattern:** one API for the page, backend merges Provesio + GIATA.

---

## Reassurance

- **Testing:** Postman (E2E) + `aws lambda invoke` (GIATA alone) + CloudWatch (glue) — that’s enough.
- **Architecture:** Lambda invoke, not public HTTP — **correct choice**.
- **Risk to existing API:** Low — additive merge, fail-safe, single endpoint, other APIs untouched.

Your doc at `doc/giata-enrichment.md` already captures deployment and troubleshooting for the team.