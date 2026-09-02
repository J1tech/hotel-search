import axios from "axios";
import { globalHeaders, InternalError } from "../helper/helper.js";

const IMAGE_CACHE_MAX_AGE = Number(process.env.IMAGE_PROXY_CACHE_MAX_AGE || 31536000);

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

function jsonError(statusCode, body) {
    return {
        ...globalHeaders(),
        statusCode,
        headers: {
            ...globalHeaders().headers,
            "Content-Type": "application/json",
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

        return {
            statusCode: 200,
            headers: {
                ...globalHeaders().headers,
                "Content-Type": contentType,
                "Cache-Control": `public, max-age=${IMAGE_CACHE_MAX_AGE}, immutable`,
            },
            body: buffer.toString("base64"),
            isBase64Encoded: true,
        };
    } catch (error) {
        console.error(
            "Error in imageProxy:",
            error.response?.data || error.message,
            error.stack,
        );
        return await InternalError(error);
    }
};
