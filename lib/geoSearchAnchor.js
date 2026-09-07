import axios from "axios";
import { distanceMeters } from "./distance.js";
import { enrichHotelWithCoordinates, readHotelCoordinates } from "./normalizeHotelCoordinates.js";

const PLACES_BASE = "https://places.googleapis.com/v1";
const GEO_GEOCODE_CACHE_TTL = Number(process.env.GEO_GEOCODE_CACHE_TTL || 604800);
export const GEO_SEARCH_DEFAULT_RADIUS_KM = Number(process.env.GEO_SEARCH_DEFAULT_RADIUS_KM || 5);

export class GeoSearchError extends Error {
    constructor(message, statusCode = 400) {
        super(message);
        this.name = "GeoSearchError";
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

export function getGeocodeCacheKey(nearPlace, cityHint) {
    const place = String(nearPlace ?? "").trim().toLowerCase();
    const city = String(cityHint ?? "").trim().toLowerCase();
    return `geo:geocode:v1:${place}|${city}`;
}

function metersToKm(meters) {
    return Math.round((meters / 1000) * 100) / 100;
}

export async function geocodeNearPlace(nearPlace, cityHint) {
    const query = cityHint ? `${nearPlace} ${cityHint}`.trim() : String(nearPlace).trim();
    if (!query) {
        throw new GeoSearchError("nearPlace is required for geocoding");
    }

    const cacheKey = getGeocodeCacheKey(nearPlace, cityHint);
    try {
        const { default: redis } = await import("./redisClient.js");
        const cached = await redis.get(cacheKey);
        if (cached) {
            console.log("geoSearch geocode cache hit", { cacheKey });
            return { ...JSON.parse(cached), cacheHit: true };
        }
    } catch (error) {
        console.error("Redis geocode GET error:", error.message);
    }

    if (!process.env.GOOGLE_PLACES_API_KEY) {
        throw new GeoSearchError("GOOGLE_PLACES_API_KEY is not configured", 500);
    }

    const { data } = await axios.post(
        `${PLACES_BASE}/places:searchText`,
        { textQuery: query, pageSize: 1 },
        {
            timeout: 15000,
            headers: googleHeaders("places.id,places.displayName,places.location"),
        }
    );

    const place = data?.places?.[0];
    const latitude = Number(place?.location?.latitude);
    const longitude = Number(place?.location?.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        throw new GeoSearchError(`Could not geocode place: ${nearPlace}`);
    }

    const result = {
        latitude,
        longitude,
        displayName: place.displayName?.text || nearPlace,
        source: "google",
    };

    try {
        const { default: redis } = await import("./redisClient.js");
        await redis.set(cacheKey, JSON.stringify(result), "EX", GEO_GEOCODE_CACHE_TTL);
    } catch (error) {
        console.error("Redis geocode SET error:", error.message);
    }

    console.log("geoSearch geocode resolved", {
        nearPlace,
        cityHint,
        cacheHit: false,
        latitude: result.latitude,
        longitude: result.longitude,
    });

    return { ...result, cacheHit: false };
}

/**
 * Resolve the search anchor from client payload.
 * Prefers explicit lat/lng; falls back to Google geocode for nearPlace.
 */
export async function resolveSearchAnchor(searchAnchor, cityHint) {
    if (!searchAnchor || typeof searchAnchor !== "object") {
        return null;
    }

    const latitude = Number(searchAnchor.latitude);
    const longitude = Number(searchAnchor.longitude);
    if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
        return {
            latitude,
            longitude,
            displayName:
                searchAnchor.displayName ||
                searchAnchor.nearPlace ||
                null,
            source: "client",
            cacheHit: null,
        };
    }

    const nearPlace = String(searchAnchor.nearPlace ?? "").trim();
    if (nearPlace) {
        return geocodeNearPlace(nearPlace, cityHint);
    }

    return null;
}

export function attachDistanceKm(hotels, anchorLat, anchorLng) {
    if (!Array.isArray(hotels)) {
        return { hotels: [], hotelsWithCoordinates: 0, hotelsMissingCoordinates: 0 };
    }

    let hotelsWithCoordinates = 0;
    let hotelsMissingCoordinates = 0;

    const enriched = hotels.map((hotel) => {
        const coords = readHotelCoordinates(hotel);
        const withCoords = enrichHotelWithCoordinates(hotel);

        if (!coords) {
            hotelsMissingCoordinates += 1;
            return withCoords;
        }

        hotelsWithCoordinates += 1;
        const distanceKm = metersToKm(
            distanceMeters(anchorLat, anchorLng, coords.latitude, coords.longitude)
        );

        return { ...withCoords, distanceKm };
    });

    enriched.sort((a, b) => {
        if (a.distanceKm == null && b.distanceKm == null) return 0;
        if (a.distanceKm == null) return 1;
        if (b.distanceKm == null) return -1;
        return a.distanceKm - b.distanceKm;
    });

    return { hotels: enriched, hotelsWithCoordinates, hotelsMissingCoordinates };
}

/**
 * Apply hybrid geo enrichment to a hotel search response (post-Provesio, post-cache).
 * Does not filter by radius — FE owns the slider.
 */
export function applyGeoSearchToResponse(responseData, resolvedAnchor, searchAnchor) {
    if (!resolvedAnchor || !responseData || typeof responseData !== "object") {
        return responseData;
    }

    if (!Array.isArray(responseData.data)) {
        return responseData;
    }

    const { hotels, hotelsWithCoordinates, hotelsMissingCoordinates } = attachDistanceKm(
        responseData.data,
        resolvedAnchor.latitude,
        resolvedAnchor.longitude
    );

    responseData.data = hotels;
    responseData.geoSearch = {
        anchor: {
            latitude: resolvedAnchor.latitude,
            longitude: resolvedAnchor.longitude,
            displayName:
                resolvedAnchor.displayName ||
                searchAnchor?.displayName ||
                searchAnchor?.nearPlace ||
                null,
            source: resolvedAnchor.source,
        },
        defaultRadiusKm: GEO_SEARCH_DEFAULT_RADIUS_KM,
        hotelsWithCoordinates,
        hotelsMissingCoordinates,
    };

    console.log("geoSearch applied", {
        source: resolvedAnchor.source,
        geocodeCacheHit: resolvedAnchor.cacheHit,
        hotelsWithCoordinates,
        hotelsMissingCoordinates,
    });

    return responseData;
}
