import axios from "axios";
import { computeTTLFromSupplier, getSessionId, globalHeaders, logTrace, InternalError } from "../helper/helper.js";
import { v4 as uuidv4 } from "uuid";
import redis from "../lib/redisClient.js";
import { createCacheKey } from "../lib/cacheKey.js";
import { verifyToken } from "./authorizerLayer.js";
import { DynamoDBClient, PutItemCommand, UpdateItemCommand, QueryCommand } from "@aws-sdk/client-dynamodb";
const dynamo = new DynamoDBClient({ region: process.env.REGION });

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

        if (authVerification?.context?.userType === 'guest') {
            return {
                ...globalHeaders(),
                statusCode: 401,
                body: JSON.stringify({
                    message: "Unauthorized: Guest User is not allowed for reservation booking",
                }),
            };
        }

        const body = typeof event.body === "string" ? JSON.parse(event.body) : event.body;


        const {
            command,
            bookingReferenceId,
            bookingKey
        } = body || {};

        // --- validation (your existing code) ---
        if (!command) {
            return {
                ...globalHeaders(),
                statusCode: 400,
                body: JSON.stringify({ message: "command is required" }),
            };
        }

        if (!bookingReferenceId) {
            return {
                ...globalHeaders(),
                statusCode: 400,
                body: JSON.stringify({ message: "bookingReferenceId is required" }),
            };
        }

        if (!bookingKey) {
            return {
                ...globalHeaders(),
                statusCode: 400,
                body: JSON.stringify({ message: "bookingKey is required" }),
            };
        }

        const result = await dynamo.send(
            new QueryCommand({
                TableName: process.env.HOTEL_BOOK_TABLE,
                KeyConditionExpression: "bookingReferenceId = :id",
                ExpressionAttributeValues: {
                    ":id": {
                        S: bookingReferenceId,
                    },
                },
            })
        );

        if (!result.Items || result.Items.length === 0) {
            return {
                ...globalHeaders(),
                statusCode: 404,
                body: JSON.stringify({
                    message: "Booking not found",
                }),
            };
        }

        const conversationId = result.Items[0].conversationId.S || uuidv4();
        // Session ID
        const { sessionId } = await getSessionId();
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
            ...body,
            transactionId: Math.floor(10000 + Math.random() * 90000)
        };

        console.log("searchPayload************", searchPayload);
        console.log("`${BASE_URL}/reservation/hotel-cancel`***********I", `${BASE_URL}/reservation/hotel-cancel`);

        // ---- CALL PROVESIO ----
        const searchResp = await axios.post(
            `${BASE_URL}/reservation/hotel-cancel`,
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
            stepCode: 180,
            status: "active"
        };

        await logTrace(payload);

        const hotelCancellationBookObj = {
            bookingStatus: searchResp.data?.data[0].bookingStatus,
            bookingReferenceId: searchResp.data?.data[0].bookingReferenceId,
            command: searchResp.data?.data[0].command,
            userId: authVerification?.context?.sub,
            userType: authVerification?.context?.userType,
            request: JSON.stringify(body),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        const putCmd = new PutItemCommand({
            TableName: process.env.HOTEL_CANCELLATION_TABLE,
            Item: {
                bookingStatus: { S: hotelCancellationBookObj.bookingStatus },
                bookingReferenceId: { S: hotelCancellationBookObj.bookingReferenceId },
                command: { S: hotelCancellationBookObj.command },
                userId: { S: hotelCancellationBookObj.userId },
                userType: { S: hotelCancellationBookObj.userType },
                request: { S: hotelCancellationBookObj.request },
                createdAt: { S: hotelCancellationBookObj.createdAt },
                updatedAt: { S: hotelCancellationBookObj.updatedAt }
            }
        });

        await dynamo.send(putCmd);

        const updateCmd = new UpdateItemCommand({
            TableName: process.env.HOTEL_PRE_BOOK_TABLE,
            Key: {
                bookingKey: { S: bookingKey }
            },
            UpdateExpression: "SET #st = :status",
            ExpressionAttributeNames: {
                "#st": "status"
            },
            ExpressionAttributeValues: {
                ":status": { S: "cancelled" }
            }
        });

        await dynamo.send(updateCmd);

        return {
            statusCode: 200,
            ...globalHeaders(),
            body: JSON.stringify(searchResp.data),
        };

    } catch (error) {
        console.error("Error in get more rooms:", error.response?.data || error.message, error.stack);
        return await InternalError(error);
    }
};
