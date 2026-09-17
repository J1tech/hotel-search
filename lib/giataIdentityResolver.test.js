import test from "node:test";
import assert from "node:assert/strict";
import { parseSupplierFromHotelKey, resolveGiataIdentity } from "./giataIdentityResolver.js";

test("parseSupplierFromHotelKey supports HOTELBEDS and TBOHOLIDAYS", () => {
    assert.equal(parseSupplierFromHotelKey("uuidHOTELBEDSHTR001"), "HOTELBEDS");
    assert.equal(parseSupplierFromHotelKey("uuidTBOHOLIDAYSHTR001"), "TBOHOLIDAYS");
    assert.equal(parseSupplierFromHotelKey("uuidDOTW123"), null);
});

test("resolveGiataIdentity prefers cspId", () => {
    const result = resolveGiataIdentity(
        { propertyInfo: { providerHotelId: "1" } },
        { cspId: "1412933", hotelKey: "k" },
        { culture: "en", include: ["images"] },
    );
    assert.equal(result.reason, "resolved_csp_id");
    assert.deepEqual(result.payload, { cspId: "1412933", culture: "en", include: ["images"] });
});

test("resolveGiataIdentity maps TBO from hotelKey", () => {
    const result = resolveGiataIdentity(
        { propertyInfo: { providerHotelId: "1043287" }, hotelKey: "uuidTBOHOLIDAYSHTR001" },
        { hotelKey: "uuidTBOHOLIDAYSHTR001" },
        { culture: "en", include: ["images"] },
    );
    assert.equal(result.reason, "resolved_supplier_mapping");
    assert.deepEqual(result.payload, {
        providerHotelId: "1043287",
        supplier: "TBOHOLIDAYS",
        culture: "en",
        include: ["images"],
    });
    assert.equal(result.resolved.supplierSource, "hotelKey");
});

test("resolveGiataIdentity rejects unsupported supplier", () => {
    const result = resolveGiataIdentity(
        { propertyInfo: { providerHotelId: "1" }, rooms: [{ financialInfo: { supplier: "DOTW" } }] },
        {},
        { culture: "en", include: ["images"] },
    );
    assert.equal(result.reason, "unsupported_supplier");
    assert.equal(result.payload, null);
});
