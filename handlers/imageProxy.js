import axios from "axios";
import { createHash } from "node:crypto";
import { globalHeaders, InternalError } from "../helper/helper.js";

const IMAGE_CACHE_MAX_AGE = Number(process.env.IMAGE_PROXY_CACHE_MAX_AGE || 31536000);

// Warm-container cache: repeated requests for the same image served by the same
// Lambda instance skip the upstream (GIATA/Provesio) fetch entirely.
const MEMORY_CACHE_MAX_BYTES = Number(process.env.IMAGE_PROXY_MEMORY_CACHE_BYTES || 32 * 1024 * 1024);
const MEMORY_CACHE_TTL_MS = Number(process.env.IMAGE_PROXY_MEMORY_CACHE_TTL_MS || 60 * 60 * 1000);
const MEMORY_CACHE_MAX_ITEM_BYTES = Number(process.env.IMAGE_PROXY_MEMORY_CACHE_ITEM_BYTES || 2 * 1024 * 1024);

const memoryCache = new Map(); // imageUrl -> { buffer, contentType, etag, expiresAt }
let memoryCacheBytes = 0;

function memoryCacheGet(imageUrl) {
    const entry = memoryCache.get(imageUrl);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
        memoryCache.delete(imageUrl);
        memoryCacheBytes -= entry.buffer.length;
        return null;
    }
    // Refresh LRU position.
    memoryCache.delete(imageUrl);
    memoryCache.set(imageUrl, entry);
    return entry;
}

function memoryCacheSet(imageUrl, entry) {
    const size = entry.buffer.length;
    if (size > MEMORY_CACHE_MAX_ITEM_BYTES || size > MEMORY_CACHE_MAX_BYTES) return;

    const existing = memoryCache.get(imageUrl);
    if (existing) {
        memoryCache.delete(imageUrl);
        memoryCacheBytes -= existing.buffer.length;
    }

    // Evict least-recently-used entries until the new one fits.
    for (const [key, old] of memoryCache) {
        if (memoryCacheBytes + size <= MEMORY_CACHE_MAX_BYTES) break;
        memoryCache.delete(key);
        memoryCacheBytes -= old.buffer.length;
    }

    memoryCache.set(imageUrl, { ...entry, expiresAt: Date.now() + MEMORY_CACHE_TTL_MS });
    memoryCacheBytes += size;
}

function isGiataMediaUrl(imageUrl) {
    return /giatamedia\.com/i.test(String(imageUrl ?? ""));
}

function inferContentType(imageUrl, upstreamContentType) {
    const ct = String(upstreamContentType ?? "").split(";")[0].trim().toLowerCase();
    if (ct.startsWith("image/")) return ct;

    const extMatch = String(imageUrl).match(/\.(png|jpg|jpeg|gif|webp)(?:$|[?#])/i);
    if (extMatch) {
        const ext = extMatch[1].toLowerCase();
        if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
        return `image/${ext}`;
    }

    return "image/jpeg";
}

function buildFetchConfig(imageUrl) {
    const config = {
        responseType: "arraybuffer",
        timeout: Number(process.env.GIATA_TIMEOUT_MS || 20000),
        validateStatus: (status) => status < 500,
    };

    if (isGiataMediaUrl(imageUrl)) {
        const username = process.env.GIATA_USERNAME;
        const password = process.env.GIATA_PASSWORD;
        if (!username || !password) {
            throw new Error("GIATA credentials not configured for imageProxy");
        }
        config.auth = { username, password };
    }

    return config;
}

function requestHeader(event, name) {
    const headers = event?.headers || {};
    const wanted = name.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() === wanted) return value;
    }
    return undefined;
}

function etagMatches(ifNoneMatch, etag) {
    if (!ifNoneMatch) return false;
    if (ifNoneMatch.trim() === "*") return true;
    const strip = (v) => v.trim().replace(/^W\//, "");
    return ifNoneMatch.split(",").some((candidate) => strip(candidate) === strip(etag));
}

function computeEtag(buffer) {
    return `"${createHash("sha1").update(buffer).digest("base64url")}"`;
}

function imageHeaders(contentType, etag) {
    return {
        ...globalHeaders().headers,
        "Content-Type": contentType,
        "Cache-Control": `public, max-age=${IMAGE_CACHE_MAX_AGE}, immutable`,
        Expires: new Date(Date.now() + IMAGE_CACHE_MAX_AGE * 1000).toUTCString(),
        ETag: etag,
    };
}

function imageResponse(event, { buffer, contentType, etag }) {
    if (etagMatches(requestHeader(event, "if-none-match"), etag)) {
        return {
            statusCode: 304,
            headers: imageHeaders(contentType, etag),
            body: "",
        };
    }

    return {
        statusCode: 200,
        headers: imageHeaders(contentType, etag),
        body: buffer.toString("base64"),
        isBase64Encoded: true,
    };
}

function jsonError(statusCode, body) {
    return {
        ...globalHeaders(),
        statusCode,
        headers: {
            ...globalHeaders().headers,
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
        },
        body: JSON.stringify(body),
    };
}

export const handler = async (event) => {
    try {
        const query = event.queryStringParameters || {};
        const { imageUrl } = query;

        if (!imageUrl) {
            return jsonError(400, { message: "imageUrl is required" });
        }

        const cached = memoryCacheGet(imageUrl);
        if (cached) {
            return imageResponse(event, cached);
        }

        const response = await axios.get(imageUrl, buildFetchConfig(imageUrl));

        if (response.status >= 400) {
            console.error("imageProxy upstream error", {
                status: response.status,
                imageUrl,
                giata: isGiataMediaUrl(imageUrl),
            });
            return jsonError(response.status, {
                message: "Failed to fetch image",
                status: response.status,
            });
        }

        const contentType = inferContentType(
            imageUrl,
            response.headers?.["content-type"],
        );
        const buffer = Buffer.from(response.data);
        const entry = { buffer, contentType, etag: computeEtag(buffer) };

        memoryCacheSet(imageUrl, entry);

        return imageResponse(event, entry);
    } catch (error) {
        console.error(
            "Error in imageProxy:",
            error.response?.data || error.message,
            error.stack,
        );
        return await InternalError(error);
    }
};
