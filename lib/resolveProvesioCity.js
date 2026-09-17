import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ALLOWLIST_PATH = join(__dirname, "data", "provesio-city-allowlist.json");

/** Lowercase "city|country" → canonical { city, country } from vendor data */
const CANONICAL_BY_KEY = new Map();
/** Lowercase country → Set of lowercase city names (for fuzzy match) */
const CITIES_BY_COUNTRY = new Map();

/** Known neighbourhood / geocoder labels → wide Provesio city (within country) */
const CITY_ALIASES = {
    "england|united kingdom": "London",
    "deira|united arab emirates": "Dubai",
    "dubai marina|united arab emirates": "Dubai",
    "jumeirah beach residence|united arab emirates": "Dubai",
    "jbr|united arab emirates": "Dubai",
    "business bay|united arab emirates": "Dubai",
    "downtown dubai|united arab emirates": "Dubai",
    "palm jumeirah|united arab emirates": "Dubai",
};

let loaded = false;

function normalizeKey(city, country) {
    return `${String(city ?? "").trim().toLowerCase()}|${String(country ?? "").trim().toLowerCase()}`;
}

function loadAllowlist() {
    if (loaded) return;

    const raw = readFileSync(ALLOWLIST_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const items = Array.isArray(parsed?.items) ? parsed.items : [];

    for (const item of items) {
        const city = String(item?.vendorCity ?? "").trim();
        const country = String(item?.vendorCountry ?? "").trim();
        if (!city || !country) continue;

        const key = normalizeKey(city, country);
        CANONICAL_BY_KEY.set(key, { city, country });

        const countryKey = country.toLowerCase();
        if (!CITIES_BY_COUNTRY.has(countryKey)) {
            CITIES_BY_COUNTRY.set(countryKey, new Set());
        }
        CITIES_BY_COUNTRY.get(countryKey).add(city.toLowerCase());
    }

    loaded = true;
}

export function isProvesioCityAllowed(city, country) {
    loadAllowlist();
    return CANONICAL_BY_KEY.has(normalizeKey(city, country));
}

function canonicalCity(city, country) {
    loadAllowlist();
    const hit = CANONICAL_BY_KEY.get(normalizeKey(city, country));
    return hit ? hit.city : city;
}

function parseDisplayNameSegments(displayName) {
    return String(displayName ?? "")
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
}

function matchFromAlias(city, country) {
    const key = normalizeKey(city, country);
    const aliased = CITY_ALIASES[key];
    if (!aliased) return null;

    if (isProvesioCityAllowed(aliased, country)) {
        return {
            provesioCity: canonicalCity(aliased, country),
            provesioCountry: country,
            resolution: "alias",
        };
    }
    return null;
}

function matchFromSegments(segments, country) {
    for (const segment of segments) {
        if (isProvesioCityAllowed(segment, country)) {
            return {
                provesioCity: canonicalCity(segment, country),
                provesioCountry: country,
                resolution: "parsed",
                matchedSegment: segment,
            };
        }
    }
    return null;
}

function fuzzyMatchCity(city, country) {
    loadAllowlist();
    const needle = String(city ?? "").trim().toLowerCase();
    const countryKey = String(country ?? "").trim().toLowerCase();
    if (!needle || !countryKey) return null;

    const cities = CITIES_BY_COUNTRY.get(countryKey);
    if (!cities) return null;

    if (cities.has(needle)) {
        return {
            provesioCity: canonicalCity(city, country),
            provesioCountry: country,
            resolution: "fuzzy",
        };
    }

    for (const candidate of cities) {
        if (candidate.startsWith(needle) || needle.startsWith(candidate)) {
            return {
                provesioCity: canonicalCity(candidate, country),
                provesioCountry: country,
                resolution: "fuzzy",
            };
        }
    }

    return null;
}

/**
 * Resolve user city/country to a Provesio-valid pair before /hotel/search.
 *
 * @param {{ city: string, country: string, searchAnchor?: object }} input
 * @returns {{
 *   provesioCity: string,
 *   provesioCountry: string,
 *   inputCity: string,
 *   resolution: 'allowlist'|'alias'|'parsed'|'fuzzy'|'passthrough'
 *   matchedSegment?: string
 * }}
 */
export function resolveProvesioCity({ city, country, searchAnchor }) {
    loadAllowlist();

    const inputCity = String(city ?? "").trim();
    const provesioCountry = String(country ?? "").trim();
    const displayName = searchAnchor?.displayName || searchAnchor?.nearPlace || "";
    const segments = parseDisplayNameSegments(displayName);

    const base = {
        inputCity,
        provesioCountry,
    };

    if (!inputCity || !provesioCountry) {
        return {
            ...base,
            provesioCity: inputCity,
            resolution: "passthrough",
        };
    }

    // Area/landmark search: prefer parent city from Google displayName (e.g. Deira → Dubai)
    if (searchAnchor && segments.length > 1) {
        const parentSegments = segments.slice(1);
        const fromParent = matchFromSegments(parentSegments, provesioCountry);
        if (fromParent) {
            return { ...base, ...fromParent };
        }
    }

    const fromAlias = matchFromAlias(inputCity, provesioCountry);
    if (fromAlias) {
        return { ...base, ...fromAlias };
    }

    if (isProvesioCityAllowed(inputCity, provesioCountry)) {
        return {
            ...base,
            provesioCity: canonicalCity(inputCity, provesioCountry),
            resolution: "allowlist",
        };
    }

    if (segments.length > 0) {
        const fromSegments = matchFromSegments(segments, provesioCountry);
        if (fromSegments) {
            return { ...base, ...fromSegments };
        }
    }

    const fromFuzzy = fuzzyMatchCity(inputCity, provesioCountry);
    if (fromFuzzy) {
        return { ...base, ...fromFuzzy };
    }

    return {
        ...base,
        provesioCity: inputCity,
        resolution: "passthrough",
    };
}

/** @internal Test helper — reset module cache between tests */
export function __resetAllowlistForTests() {
    CANONICAL_BY_KEY.clear();
    CITIES_BY_COUNTRY.clear();
    loaded = false;
}
