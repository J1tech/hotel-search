/** GIATA mapping suppliers supported in hotel-search (Provesio labels). */
export const GIATA_SUPPORTED_SUPPLIERS = Object.freeze(["HOTELBEDS", "TBOHOLIDAYS"]);

function normalizeSupplier(value) {
    const normalized = String(value ?? "").trim().toUpperCase();
    return normalized || null;
}

export function parseSupplierFromHotelKey(hotelKey) {
    if (!hotelKey || typeof hotelKey !== "string") return null;
    if (hotelKey.includes("HOTELBEDS")) return "HOTELBEDS";
    if (hotelKey.includes("TBOHOLIDAYS")) return "TBOHOLIDAYS";
    return null;
}

function resolveCspId(giataHints, row) {
    const value =
        giataHints.cspId ??
        row?.cspId ??
        row?.propertyInfo?.cspId;
    const cspId = value != null ? String(value).trim() : "";
    if (!cspId) return { cspId: null, source: null };
    return { cspId, source: giataHints.cspId ? "request" : "detail" };
}

function resolveProviderHotelId(giataHints, row) {
    const value =
        giataHints.providerHotelId ??
        row?.providerHotelId ??
        row?.propertyInfo?.providerHotelId;
    const providerHotelId = value != null ? String(value).trim() : "";
    if (!providerHotelId) return { providerHotelId: null, source: null };
    return {
        providerHotelId,
        source: giataHints.providerHotelId ? "request" : "detail",
    };
}

function resolveSupplier(giataHints, row) {
    const hotelKey = giataHints.hotelKey ?? row?.hotelKey;

    if (giataHints.supplier) {
        return {
            supplier: normalizeSupplier(giataHints.supplier),
            source: "request",
        };
    }

    const fromRoom = normalizeSupplier(row?.rooms?.[0]?.financialInfo?.supplier);
    if (fromRoom) {
        return { supplier: fromRoom, source: "room" };
    }

    const fromKey = parseSupplierFromHotelKey(hotelKey);
    if (fromKey) {
        return { supplier: fromKey, source: "hotelKey" };
    }

    return { supplier: null, source: null };
}

/**
 * Resolve GIATA invoke identity from hotelDetail Provesio row + request hints.
 * @returns {{ payload: object|null, reason: string, resolved: object }}
 */
export function resolveGiataIdentity(row, giataHints = {}, options = {}) {
    const include = options.include ?? ["images", "texts"];
    const culture = options.culture ?? "en";

    const { cspId, source: cspSource } = resolveCspId(giataHints, row);
    if (cspId) {
        return {
            payload: { cspId, culture, include },
            reason: "resolved_csp_id",
            resolved: {
                path: "cspId",
                cspId,
                cspSource,
            },
        };
    }

    const { providerHotelId, source: providerSource } = resolveProviderHotelId(giataHints, row);
    const { supplier, source: supplierSource } = resolveSupplier(giataHints, row);

    const resolved = {
        path: "supplier_mapping",
        providerHotelId: providerHotelId ?? undefined,
        providerHotelIdSource: providerSource ?? undefined,
        supplier: supplier ?? undefined,
        supplierSource: supplierSource ?? undefined,
        hotelKey: giataHints.hotelKey ?? row?.hotelKey,
    };

    if (!providerHotelId) {
        return {
            payload: null,
            reason: "missing_provider_hotel_id",
            resolved,
        };
    }

    if (!supplier) {
        return {
            payload: null,
            reason: "missing_supplier",
            resolved,
        };
    }

    if (!GIATA_SUPPORTED_SUPPLIERS.includes(supplier)) {
        return {
            payload: null,
            reason: "unsupported_supplier",
            resolved: { ...resolved, supplier },
        };
    }

    return {
        payload: {
            providerHotelId,
            supplier,
            culture,
            include,
        },
        reason: "resolved_supplier_mapping",
        resolved: {
            ...resolved,
            supplier,
        },
    };
}
