import test from "node:test";
import assert from "node:assert/strict";
import {
    attachDistanceKm,
    getGeocodeCacheKey,
    resolveSearchAnchor,
} from "./geoSearchAnchor.js";
import { readHotelCoordinates } from "./normalizeHotelCoordinates.js";

const DUBAI_MARINA = { latitude: 25.0772, longitude: 55.1390 };
const NEARBY_HOTEL = { latitude: 25.08, longitude: 55.14 };

test("getGeocodeCacheKey normalizes case and whitespace", () => {
    assert.equal(
        getGeocodeCacheKey("  Dubai Marina ", " Dubai "),
        getGeocodeCacheKey("dubai marina", "dubai")
    );
});

test("resolveSearchAnchor prefers client lat/lng over nearPlace", async () => {
    const anchor = await resolveSearchAnchor(
        {
            nearPlace: "Should Not Geocode",
            latitude: DUBAI_MARINA.latitude,
            longitude: DUBAI_MARINA.longitude,
            displayName: "Dubai Marina",
        },
        "Dubai"
    );

    assert.equal(anchor.source, "client");
    assert.equal(anchor.latitude, DUBAI_MARINA.latitude);
    assert.equal(anchor.longitude, DUBAI_MARINA.longitude);
    assert.equal(anchor.displayName, "Dubai Marina");
});

test("resolveSearchAnchor returns null when anchor is empty", async () => {
    assert.equal(await resolveSearchAnchor({}, "Dubai"), null);
    assert.equal(await resolveSearchAnchor(null, "Dubai"), null);
});

test("readHotelCoordinates reads string coords from propertyInfo", () => {
    const coords = readHotelCoordinates({
        propertyInfo: { latitude: "25.08", longitude: "55.14" },
    });
    assert.deepEqual(coords, NEARBY_HOTEL);
});

test("attachDistanceKm adds distanceKm and sorts nearest first", () => {
    const hotels = [
        {
            hotelKey: "far",
            propertyInfo: { latitude: "25.20", longitude: "55.30" },
        },
        {
            hotelKey: "near",
            propertyInfo: { latitude: "25.08", longitude: "55.14" },
        },
        {
            hotelKey: "missing",
            propertyInfo: { hotelName: "No coords" },
        },
    ];

    const { hotels: enriched, hotelsWithCoordinates, hotelsMissingCoordinates } = attachDistanceKm(
        hotels,
        DUBAI_MARINA.latitude,
        DUBAI_MARINA.longitude
    );

    assert.equal(hotelsWithCoordinates, 2);
    assert.equal(hotelsMissingCoordinates, 1);
    assert.equal(enriched[0].hotelKey, "near");
    assert.ok(typeof enriched[0].distanceKm === "number");
    assert.ok(enriched[0].distanceKm < enriched[1].distanceKm);
    assert.equal(enriched[1].hotelKey, "far");
    assert.equal(enriched[2].hotelKey, "missing");
    assert.equal(enriched[2].distanceKm, undefined);
});
