import { globalHeaders, InternalError } from "../helper/helper.js";
import { verifyToken } from "./authorizerLayer.js";
import {
    cacheReviews,
    getCachedReviewsByKeys,
    getGooglePlaceReviews,
    getSavedPlaceIdByKeys,
    isWithinRadius,
    placeLookupHash,
    placePairKey,
    reviewsPayload,
    savePlaceId,
    searchGooglePlace,
} from "../lib/googlePlaces.js";

function json(statusCode, payload) {
    return {
        ...globalHeaders(),
        statusCode,
        body: JSON.stringify(payload),
    };
}

function verifiedReviews(details, requestLat, requestLng) {
    if (!details?.placeId) return null;
    if (!isWithinRadius(requestLat, requestLng, details.latitude, details.longitude)) return null;
    return reviewsPayload(details);
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

        const body = typeof event.body === "string" ? JSON.parse(event.body) : event.body || {};
        const hotelName = String(body.hotelName ?? "").trim();
        const city = String(body.city ?? "").trim();
        const language = String(body.language ?? "").trim().toLowerCase();
        const latitude = Number(body.latitude);
        const longitude = Number(body.longitude);
        const supplier = String(body.supplier ?? "").trim();
        const providerHotelId = String(body.providerHotelId ?? "").trim();

        if (!hotelName) return json(400, { message: "hotelName is required" });
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
            return json(400, { message: "latitude and longitude are required numbers" });
        }
        if (!city) return json(400, { message: "city is required" });
        if (!language) return json(400, { message: "language is required" });

        const pairKey = placePairKey(supplier, providerHotelId);
        const lookupHash = placeLookupHash({ hotelName, city, latitude, longitude });
        const persistKey = pairKey || lookupHash;

        const cached = await getCachedReviewsByKeys(pairKey, lookupHash, language);
        if (cached) {
            return json(200, { success: true, data: cached });
        }

        const saveToRedis = true;
        let reviews = null;

        const savedPlace = await getSavedPlaceIdByKeys(pairKey, lookupHash);
        if (savedPlace?.placeId) {
            const details = await getGooglePlaceReviews(savedPlace.placeId, language);
            reviews = verifiedReviews(details, latitude, longitude);
        }

        if (!reviews) {
            const searched = await searchGooglePlace({
                hotelName,
                city,
                latitude,
                longitude,
                language,
            });
            if (!searched?.placeId) {
                return json(404, { message: "No Google place found for this hotel" });
            }
            if (!isWithinRadius(latitude, longitude, searched.latitude, searched.longitude)) {
                return json(404, { message: "No Google place found within 300m of this hotel" });
            }

            const details = await getGooglePlaceReviews(searched.placeId, language);
            reviews = verifiedReviews(details, latitude, longitude);
            if (!reviews) {
                return json(404, { message: "No Google place found within 300m of this hotel" });
            }

            await savePlaceId({
                placeLookupHash: persistKey,
                placeId: reviews.placeId,
                displayName: reviews.displayName,
                hotelName,
                city,
                latitude,
                longitude,
                supplier: pairKey ? supplier : undefined,
                providerHotelId: pairKey ? providerHotelId : undefined,
            });
        }

        if (saveToRedis) {
            await cacheReviews(persistKey, language, reviews);
        }
        return json(200, { success: true, data: reviews });
    } catch (error) {
        console.error("Error in get hotel reviews:", error.response?.data || error.message, error.stack);
        const googleMessage = error.response?.data?.error?.message;
        if (googleMessage) {
            return json(error.response?.status || 502, { message: googleMessage });
        }
        return await InternalError(error);
    }
};
