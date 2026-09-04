import axios from "axios";
import { computeTTLFromSupplier, getSessionId, globalHeaders, logTrace, InternalError } from "../helper/helper.js";
import { v4 as uuidv4 } from "uuid";
import redis from "../lib/redisClient.js";
import { createCacheKey } from "../lib/cacheKey.js";
// --- BEGIN GIATA (feature/giata-enrichment) ---
import { invokeGiataEnrich } from "../lib/giataInvokeClient.js";
import { resolveGiataIdentity } from "../lib/giataIdentityResolver.js";
import { applyHotelMarkupsOnResponse, loadHotelModuleSources } from "../helper/applyHotelMarkups.js";
import { verifyToken } from "./authorizerLayer.js";
import {
    DynamoDBClient,
    UpdateItemCommand
} from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
const dynamo = new DynamoDBClient({ region: process.env.region });

const BASE_URL = process.env.BASE_URL;
const CACHE_TTL_DEFAULT = Number(process.env.CACHE_TTL_DEFAULT || 60); // seconds

// --- BEGIN GIATA (feature/giata-enrichment) ---
// Option 3 orchestrator: invoke al-rais-giata-svc enrich Lambda, merge giataEnrichment sibling.
// Env: GIATA_ENRICHMENT_ENABLED, GIATA_ENRICH_FUNCTION_ARN | dep: @aws-sdk/client-lambda
// Fail-safe: errors return Provesio-only (no 500). FE picks GIATA vs Provesio for images/texts.

function buildGiataIncludeList() {
    const include = ["images", "texts"];
    if (process.env.GIATA_FACTSHEETS_ENABLED !== "false") {
        include.push("factsheets");
    }
    return include;
}

async function enrichWithGiata(responseData, culture, giataHints = {}) {
    if (process.env.GIATA_ENRICHMENT_ENABLED !== "true") {
        console.info("GIATA skipped", JSON.stringify({ reason: "giata_disabled" }));
        return responseData;
    }

    const row = responseData?.data?.[0];
    const resolution = resolveGiataIdentity(row, giataHints, {
        culture,
        include: buildGiataIncludeList(),
    });

    if (!resolution.payload) {
        console.warn("GIATA skipped", JSON.stringify({
            reason: resolution.reason,
            resolved: resolution.resolved,
        }));
        return responseData;
    }

    console.info("GIATA invoke", JSON.stringify({
        reason: resolution.reason,
        resolved: resolution.resolved,
        payload: resolution.payload,
    }));

    try {
        const result = await invokeGiataEnrich(resolution.payload);
        if (result?.meta?.success && result?.data) {
            console.info("GIATA enrichment attached", JSON.stringify({
                reason: resolution.reason,
                giataId: result.data.giataId ?? result.meta?.giataId,
                imageCount: result.data.images?.length ?? 0,
                hasTexts: result.data.texts != null,
                factCount: result.data.factsheet?.factCount ?? result.data.factsheet?.facilities?.length ?? 0,
                hasFactsheet: result.data.factsheet != null,
            }));
            responseData.giataEnrichment = result.data;
        } else {
            console.warn("GIATA returned unsuccessful response", JSON.stringify({
                reason: "giata_unsuccessful_response",
                resolutionReason: resolution.reason,
                success: result?.meta?.success,
                error: result?.meta?.error,
                statusCode: result?.meta?.statusCode,
            }));
        }
    } catch (err) {
        console.error("GIATA enrichment failed", JSON.stringify({
            reason: "giata_invoke_failed",
            resolutionReason: resolution.reason,
            message: err.message,
        }), err.stack);
    }

    return responseData;
}
// --- END GIATA helpers ---

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
            culture,
            cspId,
            providerHotelId,
            supplier,
        } = body || {};

        const giataHints = { cspId, providerHotelId, supplier, hotelKey };

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
                const parsedCache = JSON.parse(cached);
                const responseData = await enrichWithGiata(parsedCache, culture, giataHints);
                const sources = await loadHotelModuleSources();
                await applyHotelMarkupsOnResponse(responseData, { sources });
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

        // --- BEGIN GIATA: enrich after Provesio, before response (not written to Redis cache) ---
        await enrichWithGiata(searchResp.data, culture, giataHints);
        const sources = await loadHotelModuleSources();
        await applyHotelMarkupsOnResponse(searchResp.data, { sources });
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
