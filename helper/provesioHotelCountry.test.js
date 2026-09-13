import test from "node:test";
import assert from "node:assert/strict";
import { toProvesioHotelCountry } from "./provesioHotelCountry.js";
import { resolveProvesioCity } from "../lib/resolveProvesioCity.js";

test("toProvesioHotelCountry maps Türkiye to Turkey", () => {
    assert.equal(toProvesioHotelCountry("Türkiye"), "Turkey");
    assert.equal(toProvesioHotelCountry("Turkiye"), "Turkey");
});

test("toProvesioHotelCountry maps ISO2 TR to Turkey", () => {
    assert.equal(toProvesioHotelCountry("Türkiye", "TR"), "Turkey");
    assert.equal(toProvesioHotelCountry("Turkey", "TR"), "Turkey");
    assert.equal(toProvesioHotelCountry("", "TR"), "Turkey");
    assert.equal(toProvesioHotelCountry(undefined, "TR"), "Turkey");
});

test("toProvesioHotelCountry keeps existing aliases", () => {
    assert.equal(toProvesioHotelCountry("UAE"), "United Arab Emirates");
    assert.equal(toProvesioHotelCountry("Czechia"), "Czech Republic");
    assert.equal(toProvesioHotelCountry("North Macedonia"), "Macedonia");
    assert.equal(toProvesioHotelCountry("Hong Kong"), "Hongkong");
    assert.equal(toProvesioHotelCountry("Macau"), "Macao");
    assert.equal(toProvesioHotelCountry("India,IN"), "India");
});

test("toProvesioHotelCountry prefers ISO2 over Google label", () => {
    assert.equal(toProvesioHotelCountry("Türkiye", "AE"), "United Arab Emirates");
    assert.equal(toProvesioHotelCountry("Hong Kong", "HK"), "Hongkong");
});

test("Istanbul resolves on allowlist after country normalization", () => {
    const country = toProvesioHotelCountry("Türkiye");
    const result = resolveProvesioCity({ city: "Istanbul", country });
    assert.equal(country, "Turkey");
    assert.equal(result.provesioCity, "Istanbul");
    assert.equal(result.resolution, "allowlist");
});
