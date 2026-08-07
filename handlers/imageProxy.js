import axios from "axios";
import { globalHeaders, InternalError } from "../helper/helper.js";

function isGiataMediaUrl(imageUrl) {
    return /giatamedia\.com/i.test(String(imageUrl ?? ""));
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

export const handler = async (event) => {
    try {
        const query = event.queryStringParameters || {};
        const { imageUrl } = query;

        if (!imageUrl) {
            return {
                ...globalHeaders(),
                statusCode: 400,
                body: JSON.stringify({ message: "imageUrl is required" }),
            };
        }

        const response = await axios.get(imageUrl, buildFetchConfig(imageUrl));

        if (response.status >= 400) {
            console.error("imageProxy upstream error", {
                status: response.status,
                imageUrl,
                giata: isGiataMediaUrl(imageUrl),
            });
            return {
                ...globalHeaders(),
                statusCode: response.status,
                body: JSON.stringify({
                    message: "Failed to fetch image",
                    status: response.status,
                }),
            };
        }

        return {
            statusCode: 200,
            ...globalHeaders(),
            body: Buffer.from(response.data).toString("base64"),
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
