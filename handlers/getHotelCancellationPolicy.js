import axios from "axios";
import { computeTTLFromSupplier, getSessionId, globalHeaders, logTrace, InternalError } from "../helper/helper.js";
import { v4 as uuidv4 } from "uuid";
import redis from "../lib/redisClient.js";
import { createCacheKey } from "../lib/cacheKey.js";
import { verifyToken } from "./authorizerLayer.js";

const BASE_URL = process.env.BASE_URL;
const CACHE_TTL_DEFAULT = Number(process.env.CACHE_TTL_DEFAULT || 60); // seconds

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

        const {
            hotelKey,
            searchKey,
            rooms
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

        if (
            !rooms ||
            !Array.isArray(rooms) ||
            rooms.length === 0 ||
            !rooms.every(room => typeof room === "object" && room !== null)
        ) {
            return {
                ...globalHeaders(),
                statusCode: 400,
                body: JSON.stringify({
                    message: "rooms must be a non-empty array of objects"
                }),
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
            hotelKey,
            searchKey,
            rooms,
            culture: "en"
        };

        console.log("searchPayload************", searchPayload);
      
        // ---- CALL PROVESIO ----
        const searchResp = await axios.post(
            `${BASE_URL}/hotel/cancellation-policy`,
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
            stepCode: 280,
            status: "active"
        };

        await logTrace(payload);

        return {
            statusCode: 200,
            ...globalHeaders(),
            body: JSON.stringify(searchResp.data),
        };

    } catch (error) {
        console.error("Error in get more rooms*******:", error.response?.data || error.message, error.stack);
        return await InternalError(error);
    }
};
