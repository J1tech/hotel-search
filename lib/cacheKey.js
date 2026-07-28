// lib/cacheKey.js
import crypto from "crypto";

/**
 * Recursively normalize an object:
 * - remove undefined/null
 * - sort object keys
 * - sort arrays (if type hints provided or if elements are primitive)
 */
function normalize(value) {
    if (value === null || value === undefined) return undefined;

    if (Array.isArray(value)) {
        // For arrays of objects, sort by JSON string to make a stable order
        const normalizedItems = value.map(normalize).filter(v => v !== undefined);
        if (normalizedItems.every(item => typeof item !== "object")) {
            // primitives -> sort
            return normalizedItems.sort();
        }
        // objects -> stable sort by string
        return normalizedItems
            .map(item => JSON.stringify(item))
            .sort()
            .map(s => JSON.parse(s));
    }

    if (typeof value === "object") {
        const keys = Object.keys(value).filter(k => value[k] !== undefined && value[k] !== null).sort();
        const out = {};
        for (const k of keys) out[k] = normalize(value[k]);
        return out;
    }
    // primitives
    return value;
}

export function createCacheKey(obj, flag) {
    const norm = normalize(obj);
    const str = JSON.stringify(norm);
    const hash = crypto.createHash("sha256").update(str).digest("hex");
    return `${flag}:${hash}`;
}


