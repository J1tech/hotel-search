import { globalHeaders } from "../helper/helper.js";
import { verifyToken } from "./authorizerLayer.js";
import {
    autocompletePlaces,
    PlacesAutocompleteError,
} from "../lib/googlePlacesAutocomplete.js";
import {
    getPlacesAutocompleteCacheControl,
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
        input: String(query.q ?? query.query ?? "").trim(),
        sessionToken: String(query.sessionToken ?? "").trim() || undefined,
        countryBias: String(query.countryBias ?? query.country ?? "").trim() || undefined,
        languageCode: String(query.languageCode ?? query.language ?? "").trim() || undefined,
    };
}

export const handler = async (event) => {
    try {
        const authVerification = await verifyToken(event);
        if (authVerification?.principalId === "unknown") {
            return json(401, { message: "Unauthorized: Invalid or expired token" });
        }

        const { input, sessionToken, countryBias, languageCode } = readQuery(event);
        const { suggestions, cacheHit } = await autocompletePlaces({
            input,
            sessionToken,
            countryBias,
            languageCode,
        });

        return json(
            200,
            {
                meta: { success: true, cacheHit },
                data: suggestions,
            },
            getPlacesAutocompleteCacheControl()
        );
    } catch (error) {
        if (error instanceof PlacesAutocompleteError) {
            return json(error.statusCode, { message: error.message });
        }
        console.error("placesAutocomplete error:", error);
        return json(500, { message: "Internal server error" });
    }
};
