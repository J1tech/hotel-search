import test from "node:test";
import assert from "node:assert/strict";
import { resolveProvesioCity, __resetAllowlistForTests } from "./resolveProvesioCity.js";

test.afterEach(() => {
    __resetAllowlistForTests();
});

test("exact allowlist match keeps canonical casing", () => {
    const result = resolveProvesioCity({
        city: "dubai",
        country: "United Arab Emirates",
    });

    assert.equal(result.provesioCity, "Dubai");
    assert.equal(result.resolution, "allowlist");
});

test("searchAnchor displayName resolves neighbourhood to parent city", () => {
    const result = resolveProvesioCity({
        city: "Deira",
        country: "United Arab Emirates",
        searchAnchor: {
            displayName: "Deira, Dubai, United Arab Emirates",
            latitude: 25.2697,
            longitude: 55.3095,
        },
    });

    assert.equal(result.provesioCity, "Dubai");
    assert.equal(result.resolution, "parsed");
    assert.equal(result.inputCity, "Deira");
});

test("alias map resolves Deira when no displayName segments", () => {
    const result = resolveProvesioCity({
        city: "Deira",
        country: "United Arab Emirates",
        searchAnchor: { latitude: 25.2697, longitude: 55.3095 },
    });

    assert.equal(result.provesioCity, "Dubai");
    assert.equal(result.resolution, "alias");
});

test("England alias resolves to London", () => {
    const result = resolveProvesioCity({
        city: "England",
        country: "United Kingdom",
    });

    assert.equal(result.provesioCity, "London");
    assert.equal(result.resolution, "alias");
});

test("unknown city passes through", () => {
    const result = resolveProvesioCity({
        city: "Not A Real City XYZ",
        country: "United Arab Emirates",
    });

    assert.equal(result.provesioCity, "Not A Real City XYZ");
    assert.equal(result.resolution, "passthrough");
});
