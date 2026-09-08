import test from "node:test";
import assert from "node:assert/strict";
import {
    extractCountry,
    extractLocality,
    getAutocompleteCacheKey,
    getPlaceDetailsCacheKey,
    mapPlaceDetails,
    mapPlacePrediction,
} from "./googlePlacesAutocomplete.js";

test("getAutocompleteCacheKey is stable for equivalent input", () => {
    const a = getAutocompleteCacheKey({
        input: "  Dubai Marina ",
        countryBias: "ae",
        languageCode: "EN",
    });
    const b = getAutocompleteCacheKey({
        input: "dubai marina",
        countryBias: "AE",
        languageCode: "en",
    });
    assert.equal(a, b);
});

test("getPlaceDetailsCacheKey includes placeId and language", () => {
    assert.equal(
        getPlaceDetailsCacheKey("ChIJ123", "en"),
        "geo:places:details:v1:ChIJ123:en"
    );
});

test("mapPlacePrediction maps Google suggestion shape", () => {
    const mapped = mapPlacePrediction({
        placeId: "ChIJ123",
        text: { text: "Dubai Marina, Dubai, UAE" },
        structuredFormat: {
            mainText: { text: "Dubai Marina" },
            secondaryText: { text: "Dubai, UAE" },
        },
        types: ["neighborhood", "geocode"],
    });

    assert.deepEqual(mapped, {
        placeId: "ChIJ123",
        displayName: "Dubai Marina, Dubai, UAE",
        mainText: "Dubai Marina",
        secondaryText: "Dubai, UAE",
        types: ["neighborhood", "geocode"],
    });
});

test("extractLocality prefers locality over admin areas", () => {
    const city = extractLocality([
        { types: ["administrative_area_level_1"], longText: "Dubai" },
        { types: ["locality"], longText: "Dubai Marina" },
    ]);
    assert.equal(city, "Dubai Marina");
});

test("extractCountry reads long and short text", () => {
    assert.deepEqual(
        extractCountry([{ types: ["country"], longText: "United Arab Emirates", shortText: "AE" }]),
        { country: "United Arab Emirates", countryCode: "AE" }
    );
});

test("mapPlaceDetails normalizes location and address fields", () => {
    const mapped = mapPlaceDetails({
        id: "places/ChIJ123",
        displayName: { text: "Dubai Marina" },
        formattedAddress: "Dubai Marina - Dubai - UAE",
        location: { latitude: 25.0772, longitude: 55.139 },
        addressComponents: [
            { types: ["locality"], longText: "Dubai" },
            { types: ["country"], longText: "United Arab Emirates", shortText: "AE" },
        ],
    });

    assert.equal(mapped.placeId, "places/ChIJ123");
    assert.equal(mapped.displayName, "Dubai Marina");
    assert.equal(mapped.latitude, 25.0772);
    assert.equal(mapped.longitude, 55.139);
    assert.equal(mapped.city, "Dubai");
    assert.equal(mapped.countryCode, "AE");
});
