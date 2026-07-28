import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import { globalHeaders, logTrace, getSessionId } from "../helper/helper.js";
import redis from "../lib/redisClient.js"; // your redis instance
import { createCacheKey } from "../lib/cacheKey.js";
import { verifyToken } from "./authorizerLayer.js";

export const handler = async (event) => {
    try {
        // --- Token Verification ---
        const authVerification = await verifyToken(event);
        if (authVerification?.principalId === "unknown") {
            return {
                ...globalHeaders(),
                statusCode: 401,
                body: JSON.stringify({ message: "Unauthorized: Invalid or expired token" }),
            };
        }

        const body = typeof event.body === "string" ? JSON.parse(event.body) : event.body;
        const conversationId = uuidv4();
        
        // --- Session ID from Provesio ---
        const { sessionId } = await getSessionId();
        if (!sessionId) {
            return {
                ...globalHeaders(),
                statusCode: 500,
                body: JSON.stringify({ message: "Login failed, no sessionId returned." }),
            };
        }

        // --- Call Provesio Ancillary booking ---
        const searchResp = await axios.post(
            `${process.env.BASE_URL}/reservation/ancillary-prov-book`,
            body,
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

        console.log(JSON.stringify(searchResp.data, null, 2));

        // --- Log Trace ---
        const payload = {
            id: uuidv4(),
            userId: authVerification?.context?.sub,
            userType: authVerification?.context?.userType,
            request: body,
            response: searchResp.data,
            stepCode: 90,
            status: "active",
        };
        await logTrace(payload);

        return { statusCode: 200, ...globalHeaders(), body: JSON.stringify(searchResp.data) };

    } catch (error) {
        console.error("Error in ancillary search:", error.response?.data || error.message, error.stack);
        return {
            statusCode: 500,
            headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Credentials": true },
            body: JSON.stringify({
                message: error.response?.data || "Internal Server Error",
                error: error.response?.data || error.message,
            }),
        };
    }
};
