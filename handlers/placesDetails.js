import { globalHeaders } from "../helper/helper.js";
import { verifyToken } from "./authorizerLayer.js";
import {
    getPlaceDetails,
    PlacesAutocompleteError,
} from "../lib/googlePlacesAutocomplete.js";
import {
    getPlacesDetailsCacheControl,
    PLACES_NO_STORE,
} from "../lib/placesCacheHeaders.js";

function json(statusCode, payload, cacheControl = PLACES_NO_STORE) {
    const base = globalHeaders();
    return {
        ...base,
        statusCode,
        headers: {
            ...base.headers,
            "Cache-Control": cacheControl,
        },
        body: JSON.stringify(payload),
    };
}

function readQuery(event) {
    const query = event.queryStringParameters || {};
    return {
        placeId: String(query.placeId ?? "").trim(),
        sessionToken: String(query.sessionToken ?? "").trim() || undefined,
        languageCode: String(query.languageCode ?? query.language ?? "").trim() || undefined,
    };
}

export const handler = async (event) => {
    try {
        const authVerification = await verifyToken(event);
        if (authVerification?.principalId === "unknown") {
            return json(401, { message: "Unauthorized: Invalid or expired token" });
        }

        const { placeId, sessionToken, languageCode } = readQuery(event);
        const details = await getPlaceDetails({ placeId, sessionToken, languageCode });

        const { cacheHit, ...data } = details;

        return json(
            200,
            {
                meta: { success: true, cacheHit },
                data,
            },
            getPlacesDetailsCacheControl()
        );
    } catch (error) {
        if (error instanceof PlacesAutocompleteError) {
            return json(error.statusCode, { message: error.message });
        }
        console.error("placesDetails error:", error);
        return json(500, { message: "Internal server error" });
    }
};
