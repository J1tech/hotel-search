import axios from "axios";
import { computeTTLFromSupplier, getSessionId, globalHeaders, logTrace, InternalError } from "../helper/helper.js";
import { v4 as uuidv4 } from "uuid";
import redis from "../lib/redisClient.js";
import { createCacheKey } from "../lib/cacheKey.js";
import { invokeGiataEnrich } from "../lib/giataInvokeClient.js";
import { verifyToken } from "./authorizerLayer.js";
import {
    DynamoDBClient,
    UpdateItemCommand
} from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
const dynamo = new DynamoDBClient({ region: process.env.region });

const BASE_URL = process.env.BASE_URL;
const CACHE_TTL_DEFAULT = Number(process.env.CACHE_TTL_DEFAULT || 60); // seconds

function buildGiataEnrichPayload(row, culture) {
    const include = culture === "ar" ? ["images", "texts"] : ["images"];
    const cspId = row?.cspId ?? row?.propertyInfo?.cspId;

    if (cspId) {
        return { cspId: String(cspId), culture, include };
    }

    const providerHotelId = row?.propertyInfo?.providerHotelId;
    const supplier = row?.rooms?.[0]?.financialInfo?.supplier;
    if (providerHotelId && supplier) {
        return { providerHotelId: String(providerHotelId), supplier, culture, include };
    }

    return null;
}

async function enrichWithGiata(responseData, culture) {
    if (process.env.GIATA_ENRICHMENT_ENABLED !== "true") {
        return responseData;
    }

    const row = responseData?.data?.[0];
    const payload = row ? buildGiataEnrichPayload(row, culture) : null;
    if (!payload) {
        return responseData;
    }

    try {
        const result = await invokeGiataEnrich(payload);
        if (result?.meta?.success && result?.data) {
            responseData.giataEnrichment = result.data;
        }
    } catch (err) {
        console.error("GIATA enrichment failed:", err.message);
    }

    return responseData;
}

export const handler = async (event) => {
    try {
        const authVerification = await verifyToken(event);
        console.log(JSON.stringify(authVerification, null, 2));
        if (authVerification?.principalId === "unknown") {
            return {
                ...globalHeaders(),
                statusCode: 401,
                body: JSON.stringify({
                    message: "Unauthorized: Invalid or expired token",
                }),
            };
        }


        const body = typeof event.body === "string" ? JSON.parse(event.body) : event.body;
        // const conversationId = uuidv4();

        const {
            hotelKey,
            searchKey,
            culture
        } = body || {};

        // --- validation (your existing code) ---
        if (!hotelKey) {
            return {
                ...globalHeaders(),
                statusCode: 400,
                body: JSON.stringify({ message: "hotelKey is required" }),
            };
        }

        if (!searchKey) {
            return {
                ...globalHeaders(),
                statusCode: 400,
                body: JSON.stringify({ message: "searchKey is required" }),
            };
        }

        if (!culture || !['en', 'ar'].includes(culture)) {
            return {
                ...globalHeaders(),
                statusCode: 400,
                body: JSON.stringify({ message: "culture must be either 'en' or 'ar'" }),
            };
        }

        // Session ID
        const { sessionId, conversationId } = await getSessionId(authVerification?.context?.sub);
        console.log("sessionId******", sessionId);
        console.log("conversationId******", conversationId);
        if (!sessionId) {
            return {
                ...globalHeaders(),
                statusCode: 500,
                body: JSON.stringify({ message: "Login failed, no sessionId returned." }),
            };
        }


        // Prepare payload
        const searchPayload = {
            ...body
        };

        console.log("searchPayload**********", searchPayload);

        // ---- CACHING: CHECK REDIS ----
        const cacheKey = createCacheKey({ hotelKey, searchKey, culture }, "hotelDetails");

        try {
            const cached = await redis.get(cacheKey);

            if (cached) {
                console.info("Cache HIT for", cacheKey);
                const responseData = await enrichWithGiata(JSON.parse(cached), culture);
                return {
                    statusCode: 200,
                    ...globalHeaders(),
                    body: JSON.stringify(responseData),
                };
            }
            console.info("Cache MISS for", cacheKey);
        } catch (redisErr) {
            console.error("Redis GET error (proceeding to API):", redisErr);
            // proceed to call supplier
        }

        // ---- CALL PROVESIO ----
        const searchResp = await axios.post(
            `${BASE_URL}/hotel/details`,
            searchPayload,
            {
                timeout: 45000,
                headers: {
                    "Content-Type": "application/json",
                    "X-API-KEY": process.env.X_API_KEY,
                    conversationId,
                    sessionId,
                },
            }
        );

        // Save logs in DB here (only on MISS) ---- implement your DB write
        // await saveSearchLog({ request: searchPayload, response: searchResp.data, cacheKey, conversationId });

        // Decide TTL
        const ttlFromSupplier = computeTTLFromSupplier(searchResp.data);
        const ttl = ttlFromSupplier || CACHE_TTL_DEFAULT;

        // Write to redis (stringify)
        try {
            await redis.set(cacheKey, JSON.stringify(searchResp.data), "EX", ttl);
            console.info("Cached result", cacheKey, "ttl", ttl);
        } catch (redisWriteErr) {
            console.error("Redis SET error:", redisWriteErr);
            // Optionally push to SQS for async caching if required
        }
        console.log("process.env.LOG_TRACE_SQS**********", process.env.LOG_TRACE_SQS);


        const payload = {
            id: uuidv4(),
            userId: authVerification?.context?.sub,
            userType: authVerification?.context?.userType,
            request: searchPayload,
            response: searchResp?.data,
            stepCode: 120,
            hotelKey: hotelKey,
            searchKey: searchKey,
            status: "active"
        };

        await logTrace(payload);

        const updateCmd = new UpdateItemCommand({
            TableName: process.env.LOG_TRACE_TABLE,
            Key: {
                id: { S: searchKey }
            },
            UpdateExpression: "SET #hk = :hotelKey",
            ExpressionAttributeNames: {
                "#hk": "hotelKey"
            },
            ExpressionAttributeValues: {
                ":hotelKey": { S: hotelKey },
            }
        });

        await dynamo.send(updateCmd);

        await enrichWithGiata(searchResp.data, culture);
        searchResp.data.sessionId = sessionId;
        return {
            statusCode: 200,
            ...globalHeaders(),
            body: JSON.stringify(searchResp.data),
        };

    } catch (error) {
        console.error("Error in flight search:", error.response?.data || error.message, error.stack);
        return await InternalError(error);
    }
};
