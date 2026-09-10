import axios from "axios";
import { computeTTLFromSupplier, getSessionId, globalHeaders, InternalError, logTrace, removedConverationId } from "../helper/helper.js";
import { v4 as uuidv4 } from "uuid";
import redis from "../lib/redisClient.js";
import { createCacheKey } from "../lib/cacheKey.js";
import { applyHotelMarkupsOnResponse } from "../helper/applyHotelMarkups.js";
import { verifyToken } from "./authorizerLayer.js";
import { DynamoDBClient, GetItemCommand, QueryCommand } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { foldPromoOntoHotelTotal, parseStoredPromo } from "../helper/hotelPromoBind.js";

const dynamo = new DynamoDBClient({ region: process.env.REGION });

const getPreBookRow = async (bookingKey) => {
    if (!bookingKey) return null;
    const result = await dynamo.send(
        new GetItemCommand({
            TableName: process.env.HOTEL_PRE_BOOK_TABLE,
            Key: { bookingKey: { S: bookingKey } },
        })
    );
    return result.Item ? unmarshall(result.Item) : null;
};

const BASE_URL = process.env.BASE_URL;
const CACHE_TTL_DEFAULT = Number(process.env.CACHE_TTL_DEFAULT || 60); // seconds

export const handler = async (event) => {
    try {
        console.log("BASE_URL************", BASE_URL);

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
            productType,
            bookingReferenceId,
            clientReferenceId = "",
            bookingKey = "",
            searchKey,
        } = body || {};

        // --- validation (your existing code) ---

        if (!productType) {
            return {
                ...globalHeaders(),
                statusCode: 400,
                body: JSON.stringify({ message: "productType is required" }),
            };
        }

        if (!searchKey) {
            return {
                ...globalHeaders(),
                statusCode: 400,
                body: JSON.stringify({ message: "searchKey is required" }),
            };
        }

        if (!bookingReferenceId) {
            return {
                ...globalHeaders(),
                statusCode: 400,
                body: JSON.stringify({ message: "bookingReferenceId is required" }),
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

        if (!conversationId) {
            return {
                ...globalHeaders(),
                statusCode: 500,
                body: JSON.stringify({ message: "Login failed, no conversationId returned." }),
            };
        }

        let provesioBookingReferenceId = bookingReferenceId;
        let storedPromo = null;
        if (bookingKey) {
            try {
                const preBook = await getPreBookRow(bookingKey);
                storedPromo = parseStoredPromo(preBook?.promo);
                const storedRef = String(preBook?.bookingReferenceId ?? "").trim();
                // Payment hydrate sends the hold UUID as bookingReferenceId.
                if (storedRef && bookingReferenceId === bookingKey) {
                    provesioBookingReferenceId = storedRef;
                }
            } catch (err) {
                console.warn("[HOTEL PROMO] retrieve pre-book promo", err?.message);
            }
        }

        const searchPayload = {
            ...body,
            bookingReferenceId: provesioBookingReferenceId,
        };

        console.log("searchPayload**********", searchPayload);

        // ---- CALL PROVESIO ----
        const searchResp = await axios.post(
            `${BASE_URL}/reservation/hotel-book-retrieve`,
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

        const payload = {
            id: uuidv4(),
            userId: authVerification?.context?.sub,
            userType: authVerification?.context?.userType,
            request: searchPayload,
            response: searchResp?.data,
            stepCode: 190,
            // hotelKey: hotelKey,
            status: "active"
        };

        await logTrace(payload);

        await applyHotelMarkupsOnResponse(searchResp.data);

        if (!storedPromo && provesioBookingReferenceId) {
            try {
                const bookQ = await dynamo.send(
                    new QueryCommand({
                        TableName: process.env.HOTEL_BOOK_TABLE,
                        KeyConditionExpression: "bookingReferenceId = :id",
                        ExpressionAttributeValues: {
                            ":id": { S: provesioBookingReferenceId },
                        },
                        Limit: 1,
                    })
                );
                const row = bookQ.Items?.[0] ? unmarshall(bookQ.Items[0]) : null;
                storedPromo = parseStoredPromo(row?.promo);
            } catch (err) {
                console.warn("[HOTEL PROMO] retrieve book promo", err?.message);
            }
        }
        if (storedPromo) {
            const hotels = Array.isArray(searchResp.data?.data)
                ? searchResp.data.data
                : [];
            for (const row of hotels) {
                if (row?.hotel) foldPromoOntoHotelTotal(row.hotel, storedPromo);
                row.promo = storedPromo;
            }
            searchResp.data.promo = storedPromo;
        }

        searchResp.data['sessionId'] = sessionId
        searchResp.data['conversationId'] = conversationId

        await removedConverationId(authVerification?.context?.sub, searchKey)
        return {
            statusCode: 200,
            ...globalHeaders(),
            body: JSON.stringify(searchResp.data),
        };

    } catch (error) {
        console.error("Error in hotel pre book:", error.response?.data || error.message, error.stack);
        return await InternalError(error);
    }
};
