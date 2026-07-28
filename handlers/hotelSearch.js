import axios from "axios";
import { computeTTLFromSupplier, getSessionId, globalHeaders, logTrace, InternalError } from "../helper/helper.js";
import { v4 as uuidv4 } from "uuid";
import redis from "../lib/redisClient.js";
import { createCacheKey } from "../lib/cacheKey.js";
import { verifyToken } from "./authorizerLayer.js";
import {
    DynamoDBClient,
    QueryCommand,
    GetItemCommand
} from "@aws-sdk/client-dynamodb";

import { unmarshall, marshall } from "@aws-sdk/util-dynamodb";

const dynamo = new DynamoDBClient({ region: process.env.REGION });

const BASE_URL = process.env.BASE_URL;
const CACHE_TTL_DEFAULT = Number(process.env.CACHE_TTL_DEFAULT || 60); // seconds

// --- Async polling config ---
const ASYNC_POLL_INTERVAL_MS = Number(process.env.ASYNC_POLL_INTERVAL_MS || 3000); // 3s between retries
const ASYNC_POLL_MAX_ATTEMPTS = Number(process.env.ASYNC_POLL_MAX_ATTEMPTS || 10); // up to 30s total

/**
 * Polls the supplier's fetchUrl until we get a real result or run out of attempts.
 * Returns the final response data, or throws if all attempts are exhausted.
 */
const pollAsyncResult = async (fetchUrl, sessionId, conversationId) => {
    const fullUrl = `${BASE_URL}${fetchUrl}`;

    for (let attempt = 1; attempt <= ASYNC_POLL_MAX_ATTEMPTS; attempt++) {
        console.log(`Polling attempt ${attempt}/${ASYNC_POLL_MAX_ATTEMPTS}: ${fullUrl}`);

        // Wait before each poll (including the first — supplier said "fetch later")
        await new Promise((resolve) => setTimeout(resolve, ASYNC_POLL_INTERVAL_MS));

        const pollResp = await axios.get(fullUrl, {
            timeout: 15000,
            headers: {
                "Content-Type": "application/json",
                "X-API-KEY": process.env.X_API_KEY,
                conversationId,
                sessionId,
            },
        });

        const statusCode = pollResp.data?.meta?.statusCode;

        if (statusCode === 2) {
            // Still not ready — "FETCH LATER" again
            console.log(`Attempt ${attempt}: still pending (statusCode 2), will retry...`);
            continue;
        }

        if (pollResp.data?.meta?.success === true) {
            // Got a real result
            console.log(`Attempt ${attempt}: received final result.`);
            return pollResp.data;
        }

        // Unexpected status from supplier
        throw new Error(
            `Unexpected poll response on attempt ${attempt}: ${JSON.stringify(pollResp.data?.meta)}`
        );
    }

    throw new Error(
        `Async poll exhausted after ${ASYNC_POLL_MAX_ATTEMPTS} attempts (${(ASYNC_POLL_MAX_ATTEMPTS * ASYNC_POLL_INTERVAL_MS) / 1000}s). Supplier result not ready.`
    );
};

export const handler = async (event) => {
    try {
        const authVerification = await verifyToken(event);
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
        const {
            country,
            city,
            checkIn,
            checkOut,
            rooms,
            travelerCountryOfResidence,
            travelerNationality,
            culture,
            filters,
            browserId
        } = body || {};


        let previousUsedFilters = { Items: [] };

        if (browserId) {
            previousUsedFilters = await dynamo.send(new QueryCommand({
                TableName: process.env.USER_FILTER_TABLE,
                IndexName: 'browserId-type-index',
                KeyConditionExpression: 'browserId = :browserId AND #type = :type',
                ExpressionAttributeNames: {
                    '#type': 'type',
                },
                ExpressionAttributeValues: marshall({
                    ':browserId': `${browserId}-hotel`,
                    ':type': 'hotel',
                }, { removeUndefinedValues: true }),
                ScanIndexForward: false,
                Limit: 1,
            }));
        }

        // --- Validation ---
        if (!country) {
            return { ...globalHeaders(), statusCode: 400, body: JSON.stringify({ message: "country is required" }) };
        }
        if (!city) {
            return { ...globalHeaders(), statusCode: 400, body: JSON.stringify({ message: "city is required" }) };
        }
        if (!checkIn || !checkOut) {
            return { ...globalHeaders(), statusCode: 400, body: JSON.stringify({ message: "checkIn & checkOut is required" }) };
        }
        if (!rooms || rooms.length === 0) {  // <-- fixed: was `!rooms && rooms.length == 0`
            return { ...globalHeaders(), statusCode: 400, body: JSON.stringify({ message: "rooms is required and must be array of object" }) };
        }
        if (!travelerCountryOfResidence || !travelerNationality) {
            return { ...globalHeaders(), statusCode: 400, body: JSON.stringify({ message: "travelerCountryOfResidence & travelerNationality is required" }) };
        }
        if (!filters?.currency) {
            return { ...globalHeaders(), statusCode: 400, body: JSON.stringify({ message: "currency is required" }) };
        }

        // Session ID
        let { sessionId, conversationId } = await getSessionId(
            authVerification?.context?.sub,
            null,
            false,
            true
        );


        if (!sessionId) {
            return { ...globalHeaders(), statusCode: 500, body: JSON.stringify({ message: "Login failed, no sessionId returned." }) };
        }
        if (!conversationId) {
            return { ...globalHeaders(), statusCode: 500, body: JSON.stringify({ message: "Login failed, no conversationId returned" }) };
        }

        filters['minStarRating'] = filters?.minStarRating || 0;
        filters['availableHotelsOnly'] = true;
        filters['payAtHotelRates'] = false;

        const searchPayload = {
            country, city, checkIn, checkOut, rooms,
            travelerCountryOfResidence, travelerNationality, culture, filters
        };

        // --- Cache check ---
        const cacheKey = createCacheKey({ country, city, checkIn, checkOut, rooms, filters }, "hotelSearch");
        console.log("cacheKey**********", cacheKey);

        try {
            const cached = await redis.get(cacheKey);
            if (cached) {

                cached['previousFilter'] = previousUsedFilters.Items?.map(item => unmarshall(item)) || [];

                return {
                    statusCode: 200,
                    ...globalHeaders(),
                    body: cached,
                };
            }
        } catch (redisErr) {
            console.error("Redis GET error (proceeding to API):", redisErr);
        }

        // --- Initial search request ---
        const searchResp = await axios.post(
            `${BASE_URL}/hotel/search`,
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

        let responseData = searchResp.data;

        // --- Handle async "FETCH LATER" response ---
        if (responseData?.meta?.statusCode === 2 && responseData?.asyncFetch?.fetchUrl) {
            console.log("Received async response, starting poll for:", responseData.asyncFetch.fetchUrl);

            responseData = await pollAsyncResult(
                responseData.asyncFetch.fetchUrl,
                sessionId,
                conversationId
            );
        }

        try {
            const supplierConfig = await axios.get(
                `${process.env.INTERNAL_BASE_URL}/internal/module-config?module=hotels`,
                {
                    headers: {
                        "X-Internal-Api-Key": process.env.INTERNAL_SUPPLIER_ROUTING_KEY,
                    },
                    timeout: 10000,
                }
            );

            // Build inactive supplier list
            const inactiveSuppliers = new Set();

            const sources = supplierConfig?.data?.items?.[0]?.sources || [];

            sources.forEach((source) => {
                if (!source.active) {
                    inactiveSuppliers.add(source.name.trim().toLowerCase());
                }
            });

            // Remove rooms from disabled suppliers
            if (Array.isArray(responseData?.data) && inactiveSuppliers.size > 0) {
                responseData.data = responseData.data
                    .map((hotel) => ({
                        ...hotel,
                        rooms: (hotel.rooms || []).filter((room) => {
                            const supplier = (room?.financialInfo?.supplier || "")
                                .trim()
                                .toLowerCase();

                            return !inactiveSuppliers.has(supplier);
                        }),
                    }))
                    .filter((hotel) => (hotel.rooms || []).length > 0);
            }
        } catch (error) {
            console.error(
                "Failed to fetch hotel module configuration. Continuing without supplier filtering.",
                error?.response?.data || error.message
            );
        }

        // --- Cache the final result ---
        const ttlFromSupplier = computeTTLFromSupplier(responseData);
        const ttl = ttlFromSupplier || CACHE_TTL_DEFAULT;

        try {
            await redis.set(cacheKey, JSON.stringify(responseData), "EX", ttl);
        } catch (redisWriteErr) {
            console.error("Redis SET error:", redisWriteErr);
        }

        // --- Log trace ---
        const payload = {
            id: responseData?.commonData?.searchKey,
            userId: authVerification?.context?.sub,
            userType: authVerification?.context?.userType,
            request: searchPayload,
            response: responseData,
            searchKey: responseData?.commonData?.searchKey,
            stepCode: 100,
            status: "active"
        };

        await logTrace(payload);
        let result
        if (browserId) {
            result = await dynamo.send(new GetItemCommand({
                TableName: process.env.USER_FILTER_TABLE,
                Key: marshall({
                    browserId
                }),
            }));
        }


        responseData['previousFilter'] = previousUsedFilters.Items?.map(item => unmarshall(item)) || [];

        return {
            statusCode: 200,
            ...globalHeaders(),
            body: JSON.stringify(responseData),
        };

    } catch (error) {
        console.error("Record failed", {
            error: error.message,
            stack: error.stack,
        });
        return await InternalError(error);
    }
};