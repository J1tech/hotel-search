import { globalHeaders, InternalError } from "../helper/helper.js";
import { verifyToken } from "./authorizerLayer.js";
import {
    cacheOverview,
    getCachedOverviewByKeys,
    getGooglePlaceRating,
    getSavedPlaceIdByKeys,
    isWithinRadius,
    overviewPayload,
    placeLookupHash,
    placePairKey,
    savePlaceId,
    searchGooglePlace,
} from "../lib/googlePlaces.js";

const MAX_HOTELS = 5;
const EMPTY_OVERVIEW = { rating: null, userRatingCount: null };

function json(statusCode, payload) {
    const base = globalHeaders();
    return {
        ...base,
        statusCode,
        headers: {
            ...base.headers,
            "Cache-Control": "no-store",
        },
        body: JSON.stringify(payload),
    };
}

function readHotel(raw) {
    if (!raw || typeof raw !== "object") return null;
    const hotelName = String(raw.hotelName ?? "").trim();
    const city = String(raw.city ?? "").trim();
    const latitude = Number(raw.latitude);
    const longitude = Number(raw.longitude);
    const supplier = String(raw.supplier ?? "").trim();
    const providerHotelId = String(raw.providerHotelId ?? "").trim();
    if (!hotelName) return null;
    if (!city) return null;
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
    return { hotelName, city, latitude, longitude, supplier, providerHotelId };
}

function verifiedOverview(details, requestLat, requestLng) {
    if (!details?.placeId) return null;
    if (!isWithinRadius(requestLat, requestLng, details.latitude, details.longitude)) return null;
    return overviewPayload(details);
}

async function resolveHotelOverview(raw) {
    const hotel = readHotel(raw);
    if (!hotel) return null;

    const pairKey = placePairKey(hotel.supplier, hotel.providerHotelId);
    const hashKey = placeLookupHash({
        hotelName: hotel.hotelName,
        city: hotel.city,
        latitude: hotel.latitude,
        longitude: hotel.longitude,
    });
    const persistKey = pairKey || hashKey;

    try {
        const cached = await getCachedOverviewByKeys(pairKey, hashKey);
        if (cached && typeof cached === "object") {
            return { key: persistKey, value: overviewPayload(cached) };
        }

        let overview = null;
        const savedPlace = await getSavedPlaceIdByKeys(pairKey, hashKey);
        if (savedPlace?.placeId) {
            const details = await getGooglePlaceRating(savedPlace.placeId);
            overview = verifiedOverview(details, hotel.latitude, hotel.longitude);
        }

        if (!overview) {
            const searched = await searchGooglePlace({
                hotelName: hotel.hotelName,
                city: hotel.city,
                latitude: hotel.latitude,
                longitude: hotel.longitude,
            });
            if (!searched?.placeId) {
                return { key: persistKey, value: EMPTY_OVERVIEW };
            }
            if (!isWithinRadius(hotel.latitude, hotel.longitude, searched.latitude, searched.longitude)) {
                return { key: persistKey, value: EMPTY_OVERVIEW };
            }

            const details = await getGooglePlaceRating(searched.placeId);
            overview = verifiedOverview(details, hotel.latitude, hotel.longitude);
            if (!overview) {
                return { key: persistKey, value: EMPTY_OVERVIEW };
            }

            await savePlaceId({
                placeLookupHash: persistKey,
                placeId: details.placeId,
                displayName: details.displayName,
                hotelName: hotel.hotelName,
                city: hotel.city,
                latitude: hotel.latitude,
                longitude: hotel.longitude,
                supplier: pairKey ? hotel.supplier : undefined,
                providerHotelId: pairKey ? hotel.providerHotelId : undefined,
            });
        }

        await cacheOverview(persistKey, overview);
        return { key: persistKey, value: overview };
    } catch (error) {
        console.error(
            "getReviewsOverview hotel failed:",
            persistKey,
            error.response?.data || error.message
        );
        return { key: persistKey, value: EMPTY_OVERVIEW };
    }
}

export const handler = async (event) => {
    try {
        const authVerification = await verifyToken(event);
        if (authVerification?.principalId === "unknown") {
            return json(401, { message: "Unauthorized: Invalid or expired token" });
        }

        if (!process.env.GOOGLE_PLACES_API_KEY) {
            return json(500, { message: "GOOGLE_PLACES_API_KEY is not configured" });
        }

        const body = typeof event.body === "string" ? JSON.parse(event.body || "{}") : event.body || {};
        const hotels = body.hotels;

        if (!Array.isArray(hotels)) {
            return json(400, { message: "hotels is required and must be an array" });
        }
        if (hotels.length === 0) {
            return json(400, { message: "hotels must contain at least one hotel" });
        }

        const batch = hotels.slice(0, MAX_HOTELS);
        const resolved = await Promise.all(batch.map(resolveHotelOverview));
        const data = {};
        for (const entry of resolved) {
            if (entry?.key) data[entry.key] = entry.value;
        }

        return json(200, { success: true, data });
    } catch (error) {
        console.error("Error in get reviews overview:", error.response?.data || error.message, error.stack);
        const googleMessage = error.response?.data?.error?.message;
        if (googleMessage) {
            return json(error.response?.status || 502, { message: googleMessage });
        }
        return await InternalError(error);
    }
};
