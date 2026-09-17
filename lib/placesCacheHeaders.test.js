import test from "node:test";
import assert from "node:assert/strict";
import {
    getPlacesAutocompleteCacheControl,
    getPlacesDetailsCacheControl,
    PLACES_NO_STORE,
} from "./placesCacheHeaders.js";

test("getPlacesAutocompleteCacheControl is public cacheable with 3d default", () => {
    assert.match(getPlacesAutocompleteCacheControl(), /^public, max-age=259200, stale-while-revalidate=/);
});

test("getPlacesDetailsCacheControl is public cacheable with 7d default", () => {
    assert.match(getPlacesDetailsCacheControl(), /^public, max-age=604800, stale-while-revalidate=/);
});

test("PLACES_NO_STORE blocks caching for errors", () => {
    assert.equal(PLACES_NO_STORE, "no-store");
});
