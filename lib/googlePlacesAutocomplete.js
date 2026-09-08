import axios from "axios";
import { createCacheKey } from "./cacheKey.js";

const PLACES_BASE = "https://places.googleapis.com/v1";
const AUTocomplete_CACHE_TTL = Number(process.env.GEO_PLACES_AUTOCOMPLETE_CACHE_TTL || 259200);
const DETAILS_CACHE_TTL = Number(
    process.env.GEO_PLACES_DETAILS_CACHE_TTL || process.env.GEO_GEOCODE_CACHE_TTL || 604800
);

const AUTocomplete_FIELD_MASK =
    "suggestions.placePrediction.placeId,suggestions.placePrediction.text,suggestions.placePrediction.structuredFormat,suggestions.placePrediction.types";

const DETAILS_FIELD_MASK =
    "id,displayName,location,formattedAddress,addressComponents";

async function getRedis() {
    const { default: redis } = await import("./redisClient.js");
    return redis;
}

export class PlacesAutocompleteError extends Error {
    constructor(message, statusCode = 400) {
        super(message);
        this.name = "PlacesAutocompleteError";
        this.statusCode = statusCode;
    }
}

function googleHeaders(fieldMask) {
    return {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": process.env.GOOGLE_PLACES_API_KEY,
        "X-Goog-FieldMask": fieldMask,
    };
}

function readGoogleLocation(location) {
    const latitude = Number(location?.latitude);
    const longitude = Number(location?.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
    return { latitude, longitude };
}

export function getAutocompleteCacheKey({ input, countryBias, languageCode }) {
    return createCacheKey(
        {
            input: String(input ?? "").trim().toLowerCase(),
            countryBias: String(countryBias ?? "").trim().toUpperCase(),
            languageCode: String(languageCode ?? "en").trim().toLowerCase(),
        },
        "geoPlacesAutocomplete"
    );
}

export function getPlaceDetailsCacheKey(placeId, languageCode) {
    const id = String(placeId ?? "").trim();
    const lang = String(languageCode ?? "en").trim().toLowerCase();
    return `geo:places:details:v1:${id}:${lang}`;
}

export function mapPlacePrediction(prediction) {
    if (!prediction?.placeId) return null;
    return {
        placeId: prediction.placeId,
        displayName: prediction.text?.text || "",
        mainText: prediction.structuredFormat?.mainText?.text || "",
        secondaryText: prediction.structuredFormat?.secondaryText?.text || "",
        types: Array.isArray(prediction.types) ? prediction.types : [],
    };
}

export function extractLocality(components) {
    if (!Array.isArray(components)) return null;
    const find = (type) => components.find((c) => c.types?.includes(type));
    return (
        find("locality")?.longText ||
        find("administrative_area_level_2")?.longText ||
        find("administrative_area_level_1")?.longText ||
        null
    );
}

export function extractCountry(components) {
    if (!Array.isArray(components)) {
        return { country: null, countryCode: null };
    }
    const country = components.find((c) => c.types?.includes("country"));
    return {
        country: country?.longText || null,
        countryCode: country?.shortText || null,
    };
}

export function mapPlaceDetails(data) {
    const location = readGoogleLocation(data?.location);
    const { country, countryCode } = extractCountry(data?.addressComponents);
    return {
        placeId: data?.id || null,
        displayName: data?.displayName?.text || "",
        formattedAddress: data?.formattedAddress || "",
        latitude: location?.latitude ?? null,
        longitude: location?.longitude ?? null,
        city: extractLocality(data?.addressComponents),
        country,
        countryCode,
    };
}

export async function autocompletePlaces({ input, sessionToken, countryBias, languageCode }) {
    const query = String(input ?? "").trim();
    if (!query) {
        throw new PlacesAutocompleteError("q is required");
    }
    if (!process.env.GOOGLE_PLACES_API_KEY) {
        throw new PlacesAutocompleteError("GOOGLE_PLACES_API_KEY is not configured", 500);
    }

    const cacheKey = getAutocompleteCacheKey({ input: query, countryBias, languageCode });
    try {
        const redis = await getRedis();
        const cached = await redis.get(cacheKey);
        if (cached) {
            console.log("places autocomplete cache hit", { cacheKey, query });
            return { suggestions: JSON.parse(cached), cacheHit: true };
        }
    } catch (error) {
        console.error("Redis autocomplete GET error:", error.message);
    }

    const body = { input: query };
    if (sessionToken) body.sessionToken = sessionToken;
    if (languageCode) body.languageCode = languageCode;

    const region = String(countryBias ?? "").trim().toUpperCase();
    if (region) {
        body.includedRegionCodes = [region];
    }

    const { data } = await axios.post(`${PLACES_BASE}/places:autocomplete`, body, {
        timeout: 15000,
        headers: googleHeaders(AUTocomplete_FIELD_MASK),
    });

    const suggestions = (data?.suggestions || [])
        .map((item) => mapPlacePrediction(item?.placePrediction))
        .filter(Boolean);

    try {
        const redis = await getRedis();
        await redis.set(cacheKey, JSON.stringify(suggestions), "EX", AUTocomplete_CACHE_TTL);
    } catch (error) {
        console.error("Redis autocomplete SET error:", error.message);
    }

    console.log("places autocomplete resolved", {
        query,
        countryBias: region || null,
        count: suggestions.length,
        cacheHit: false,
    });

    return { suggestions, cacheHit: false };
}

export async function getPlaceDetails({ placeId, sessionToken, languageCode }) {
    const id = String(placeId ?? "").trim();
    if (!id) {
        throw new PlacesAutocompleteError("placeId is required");
    }
    if (!process.env.GOOGLE_PLACES_API_KEY) {
        throw new PlacesAutocompleteError("GOOGLE_PLACES_API_KEY is not configured", 500);
    }

    const lang = String(languageCode ?? "en").trim().toLowerCase();
    const cacheKey = getPlaceDetailsCacheKey(id, lang);
    try {
        const redis = await getRedis();
        const cached = await redis.get(cacheKey);
        if (cached) {
            console.log("places details cache hit", { placeId: id, cacheKey });
            return { ...JSON.parse(cached), cacheHit: true };
        }
    } catch (error) {
        console.error("Redis place details GET error:", error.message);
    }

    const params = {};
    if (sessionToken) params.sessionToken = sessionToken;
    if (languageCode) params.languageCode = languageCode;

    const { data } = await axios.get(`${PLACES_BASE}/places/${encodeURIComponent(id)}`, {
        timeout: 15000,
        params,
        headers: googleHeaders(DETAILS_FIELD_MASK),
    });

    const details = mapPlaceDetails(data);
    if (!Number.isFinite(details.latitude) || !Number.isFinite(details.longitude)) {
        throw new PlacesAutocompleteError(`Could not resolve coordinates for place: ${id}`);
    }

    try {
        const redis = await getRedis();
        await redis.set(cacheKey, JSON.stringify(details), "EX", DETAILS_CACHE_TTL);
    } catch (error) {
        console.error("Redis place details SET error:", error.message);
    }

    console.log("places details resolved", { placeId: id, cacheHit: false });

    return { ...details, cacheHit: false };
}
