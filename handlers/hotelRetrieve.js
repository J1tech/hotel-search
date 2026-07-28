import axios from "axios";
import { computeTTLFromSupplier, getSessionId, globalHeaders, InternalError, logTrace, removedConverationId } from "../helper/helper.js";
import { v4 as uuidv4 } from "uuid";
import redis from "../lib/redisClient.js";
import { createCacheKey } from "../lib/cacheKey.js";
import { verifyToken } from "./authorizerLayer.js";
import { DynamoDBClient, UpdateItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
const dynamo = new DynamoDBClient({ region: process.env.REGION });

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

        // Prepare payload
        const searchPayload = {
            ...body,
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
