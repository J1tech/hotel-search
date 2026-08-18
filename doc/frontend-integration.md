# Frontend — GIATA integration guide

Hand this to the FE team. Backend changes are deployed; FE wiring required for best performance and images.

---

## 1. Pass `cspId` on hotel detail

**Source (listing):** `data[i].propertyInfo.cspId`

**Destination (detail request):**

```json
POST /hotelDetail
{
  "hotelKey": "<from listing>",
  "searchKey": "<from listing>",
  "culture": "en",
  "cspId": "<propertyInfo.cspId — omit if missing>"
}
```

- **Required fields:** `hotelKey`, `searchKey`, `culture` only.
- **`cspId` is optional** but **recommended** (~3× faster GIATA on dev: ~617 ms vs ~1984 ms).
- `cspId` equals GIATA `giataId` in the response.

Backend falls back to `providerHotelId` + supplier from `hotelKey` if `cspId` omitted.

---

## 2. Read enrichment from response root

```javascript
const hotel = response.data[0];           // Provesio
const giata = response.giataEnrichment;   // NOT inside data[0]
```

---

## 3. Images — GIATA default, Provesio fallback

```javascript
function getDisplayImages(response) {
  const giata = response.giataEnrichment?.images ?? [];
  const provesio = response.data?.[0]?.images ?? [];
  return giata.length > 0
    ? { source: "giata", images: giata }
    : { source: "provesio", images: provesio };
}
```

---

## 4. Display GIATA images via imageProxy

Do **not** use raw `ghgml.giatamedia.com` URLs in `<img src>` — they require auth.

```javascript
function proxyImageUrl(giataUrl) {
  const base = process.env.HOTEL_API_BASE; // e.g. https://hfus5c7uw2.execute-api.eu-west-1.amazonaws.com/dev
  return `${base}/imageProxy?imageUrl=${encodeURIComponent(giataUrl)}`;
}
```

FE decodes base64 from imageProxy response (or use existing app pattern if already implemented for Provesio images).

---

## 5. Descriptions (EN ↔ AR toggle)

On culture change, **refetch** `/hotelDetail` with `culture: "ar"` or `"en"`.

```javascript
function getGiataDescription(response) {
  const sections = response.giataEnrichment?.texts?.sections ?? [];
  if (sections.length === 0) return null;
  return sections.map((s) => s.body).filter(Boolean).join("\n\n");
}

function getDescription(response) {
  return getGiataDescription(response) ?? response.data?.[0]?.description ?? "";
}
```

`texts` may be `null` for some hotels — fallback to Provesio description.

---

## 6. What not to change

- Do not call GIATA Lambda or GHGML URLs directly.
- Do not expect `giataEnrichment` inside `data[0]`.
- Booking, search, retrieve APIs unchanged.
