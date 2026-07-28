import axios from "axios";
import { computeTTLFromSupplier, getSessionId, globalHeaders, InternalError, logTrace } from "../helper/helper.js";
import { v4 as uuidv4 } from "uuid";
import redis from "../lib/redisClient.js";
import { createCacheKey } from "../lib/cacheKey.js";
import { verifyToken } from "./authorizerLayer.js";
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";

const sqsClient = new SQSClient({
    region: "eu-west-1",
});

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
            rooms,
            hotelKey,
            searchKey
        } = body || {};

        // --- validation (your existing code) ---

        if (!Array.isArray(rooms) || rooms.length === 0) {
            return {
                ...globalHeaders(),
                statusCode: 400,
                body: JSON.stringify({ message: "rooms must be a non-empty arrays..." }),
            };
        }

        // Validate each room object
        for (const room of rooms) {
            if (!room.roomIndex) {
                return {
                    ...globalHeaders(),
                    statusCode: 400,
                    body: JSON.stringify({ message: "roomIndex is required for each room" }),
                };
            }
            if (!room.roomKey) {
                return {
                    ...globalHeaders(),
                    statusCode: 400,
                    body: JSON.stringify({ message: "roomKey is required for each room" }),
                };
            }

            if ("supplementKey" in room && (!Array.isArray(room.supplementKey) || room.supplementKey.length === 0)) {
                return {
                    ...globalHeaders(),
                    statusCode: 400,
                    body: JSON.stringify({ message: "supplementKey must be a non-empty array if provided" }),
                };
            }
        }

        if (!hotelKey) {
            return {
                ...globalHeaders(),
                statusCode: 400,
                body: JSON.stringify({ message: "hotelKey is required..." }),
            };
        }

        if (!searchKey) {
            return {
                ...globalHeaders(),
                statusCode: 400,
                body: JSON.stringify({ message: "searchKey is required" }),
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
            rooms,
            hotelKey,
            searchKey
        };

        console.log("searchPayload****************", searchPayload);

        // ---- CALL PROVESIO ----
        const searchResp = await axios.post(
            `${BASE_URL}/reservation/hotel-pre-book`,
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
            stepCode: 110,
            hotelKey: hotelKey,
            status: "active"
        };

        await logTrace(payload);
        console.log(
            "searchResp.data.data[0]:",
            JSON.stringify(searchResp?.data?.data?.[0], null, 2)
        );
        const { hotel, mandatoryBookData } = searchResp?.data?.data[0]
        console.log("hotel*****************", hotel);
        console.log("mandatoryBookData*dsdadasd*******", mandatoryBookData);

        const { hotelKey: preBookHotelKey, bookingKey, name, totalNet, currency, checkInDate, checkOutDate, priceChangeIndicator, rooms: preBookRooms, verifiedPropertyInfo, sequenceNo } = hotel
        console.log("preBookHotelKey******", preBookHotelKey);

        const hotelPreBookObj = {
            bookingKey: bookingKey,
            hotelKey: preBookHotelKey,
            name,
            totalNet,
            currency,
            priceChangeIndicator,
            checkInDate,
            checkOutDate,
            rooms: JSON.stringify(preBookRooms),
            verifiedPropertyInfo: JSON.stringify(verifiedPropertyInfo),
            sequenceNo,
            mandatoryBookData: JSON.stringify(mandatoryBookData),
            userId: authVerification?.context?.sub,
            userType: authVerification?.context?.userType,
            status: 'pending',
            request: JSON.stringify(body),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        }

        const putCmd = new PutItemCommand({
            TableName: process.env.HOTEL_PRE_BOOK_TABLE,
            Item: {
                // 🔑 Partition Key
                bookingKey: { S: hotelPreBookObj.bookingKey },

                // 🏨 Hotel data
                hotelKey: { S: hotelPreBookObj.hotelKey },
                name: { S: hotelPreBookObj.name },
                totalNet: { S: String(hotelPreBookObj.totalNet) },
                currency: { S: hotelPreBookObj.currency },
                priceChangeIndicator: { BOOL: Boolean(hotelPreBookObj.priceChangeIndicator) },
                checkInDate: { S: hotelPreBookObj.checkInDate },
                checkOutDate: { S: hotelPreBookObj.checkOutDate },

                // 📦 Complex objects (stringified)
                rooms: { S: hotelPreBookObj.rooms },
                verifiedPropertyInfo: { S: hotelPreBookObj.verifiedPropertyInfo },
                mandatoryBookData: { S: hotelPreBookObj.mandatoryBookData },
                request: { S: hotelPreBookObj.request },

                // 👤 User info
                userId: { S: hotelPreBookObj.userId },
                userType: { S: hotelPreBookObj.userType },

                // 📌 Meta
                status: { S: hotelPreBookObj.status },
                createdAt: { S: hotelPreBookObj.createdAt },
                updatedAt: { S: hotelPreBookObj.updatedAt }
            }
        });


        await dynamo.send(putCmd);

        await sqsClient.send(
            new SendMessageCommand({
                QueueUrl: process.env.ADD_TO_CART_QUEUE,
                MessageBody: JSON.stringify({
                    hotelId: hotelKey,
                    mainModule: "hotels",
                    moduleType: 'preBook',
                    moduleTypeRequest: JSON.stringify(body),
                    moduleTypeResponse: JSON.stringify(searchResp?.data),
                    userId: authVerification?.context?.sub
                })
            })
        );

        await sqsClient.send(
            new SendMessageCommand({
                QueueUrl: process.env.UPDATE_EXPIRED_HOTEL_BOOKING,
                MessageBody: JSON.stringify({
                    bookingKey: searchResp.data?.data[0]?.hotel?.bookingKey,
                }),
                DelaySeconds: 900, // ✅ 15 minutes — SQS holds the message, then delivers it
            })
        );

        console.log("working fine sqs or not ");

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
