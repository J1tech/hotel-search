import axios from "axios";
import { computeTTLFromSupplier, enqueueHotelBookingEmail, getSessionId, globalHeaders, InternalError, isHotelSupplierConfirmed, logTrace, removedConverationId } from "../helper/helper.js";
import { v4 as uuidv4 } from "uuid";
import redis from "../lib/redisClient.js";
import { createCacheKey } from "../lib/cacheKey.js";
import { verifyToken } from "./authorizerLayer.js";
import { DynamoDBClient, UpdateItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import {
    applyHotelMarkupsOnResponse,
    supplierNetFromHold,
} from "../helper/applyHotelMarkups.js";
import { markUnifiedSessionPaid, getPreBookRow } from "../lib/hotelPaymentSession.js";

const dynamo = new DynamoDBClient({ region: process.env.REGION });

const BASE_URL = process.env.BASE_URL;
const CACHE_TTL_DEFAULT = Number(process.env.CACHE_TTL_DEFAULT || 60); // seconds
const ASYNC_POLL_INTERVAL_MS = Number(process.env.ASYNC_POLL_INTERVAL_MS || 3000); // 3s between retries
const ASYNC_POLL_MAX_ATTEMPTS = Number(process.env.ASYNC_POLL_MAX_ATTEMPTS || 10); // up to 30s total

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
        console.log("BASE_URL********************", BASE_URL);

        const rawBody = typeof event.body === "string" ? JSON.parse(event.body) : event.body;
        const unifiedSessionToken =
            rawBody?.sessionToken ?? rawBody?.unifiedSessionToken ?? null;

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

        const body = rawBody;

        const {
            rooms,
            hotelKey,
            searchKey,
            bookingKey,
            totalNet,
            currency,
            culture,
            stayDateRange,
            paymentDetails,
            fort_id
        } = body || {};

        // FE sends N-Genius ref in paymentDetails.cardInfo; legacy field is fort_id
        const paymentRef = fort_id || paymentDetails?.cardInfo || null;

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

        if (!bookingKey) {
            return {
                ...globalHeaders(),
                statusCode: 400,
                body: JSON.stringify({ message: "bookingKey is required" }),
            };
        }

        const preBookRow = await getPreBookRow(bookingKey);
        if (preBookRow?.status === "confirmed") {
            return {
                ...globalHeaders(),
                statusCode: 409,
                body: JSON.stringify({
                    message: "Booking already confirmed",
                    code: "ALREADY_BOOKED",
                }),
            };
        }

        if (!totalNet) {
            return {
                ...globalHeaders(),
                statusCode: 400,
                body: JSON.stringify({ message: "totalNet is required" }),
            };
        }

        if (!currency) {
            return {
                ...globalHeaders(),
                statusCode: 400,
                body: JSON.stringify({ message: "currency is required" }),
            };
        }

        if (!culture) {
            return {
                ...globalHeaders(),
                statusCode: 400,
                body: JSON.stringify({ message: "culture is required" }),
            };
        }

        if (!stayDateRange || typeof stayDateRange !== "object") {
            return {
                ...globalHeaders(),
                statusCode: 400,
                body: JSON.stringify({ message: "stayDateRange is required and must be an object" }),
            };
        }

        const { checkIn, checkOut } = stayDateRange;

        if (!checkIn) {
            return {
                ...globalHeaders(),
                statusCode: 400,
                body: JSON.stringify({ message: "checkIn is required in stayDateRange" }),
            };
        }

        if (!checkOut) {
            return {
                ...globalHeaders(),
                statusCode: 400,
                body: JSON.stringify({ message: "checkOut is required in stayDateRange" }),
            };
        }

        if (!Array.isArray(rooms) || rooms.length === 0) {
            return {
                ...globalHeaders(),
                statusCode: 400,
                body: JSON.stringify({ message: "rooms must be a non-empty array" }),
            };
        }

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

            if (!Array.isArray(room.passengers) || room.passengers.length === 0) {
                return {
                    ...globalHeaders(),
                    statusCode: 400,
                    body: JSON.stringify({ message: `passengers array is required for roomIndex ${room.roomIndex}` }),
                };
            }

            for (const passenger of room.passengers) {
                if (!passenger.passengerKey) {
                    return {
                        ...globalHeaders(),
                        statusCode: 400,
                        body: JSON.stringify({ message: `passengerKey is required for each passenger in roomIndex ${room.roomIndex}` }),
                    };
                }
                if (passenger.isLead === undefined) {
                    return {
                        ...globalHeaders(),
                        statusCode: 400,
                        body: JSON.stringify({ message: `isLead is required for passenger ${passenger.passengerKey}` }),
                    };
                }
                if (!passenger.ptc) {
                    return {
                        ...globalHeaders(),
                        statusCode: 400,
                        body: JSON.stringify({ message: `ptc is required for passenger ${passenger.passengerKey}` }),
                    };
                }

                // passengerInfo validation
                const info = passenger.passengerInfo;
                if (!info || !info.birthDate || !info.gender || !info.nameTitle || !info.givenName || !info.surname) {
                    return {
                        ...globalHeaders(),
                        statusCode: 400,
                        body: JSON.stringify({ message: `passengerInfo is incomplete for passenger ${passenger.passengerKey}` }),
                    };
                }

                // // identityDocuments validation
                // if (!Array.isArray(passenger.identityDocuments) || passenger.identityDocuments.length === 0) {
                //     return {
                //         ...globalHeaders(),
                //         statusCode: 400,
                //         body: JSON.stringify({ message: `identityDocuments array is required for passenger ${passenger.passengerKey}` }),
                //     };
                // }
                // for (const doc of passenger.identityDocuments) {
                //     if (!doc.idDocumentNumber || !doc.idType || !doc.issuingCountryCode || !doc.dateOfIssue || !doc.expiryDate) {
                //         return {
                //             ...globalHeaders(),
                //             statusCode: 400,
                //             body: JSON.stringify({ message: `identityDocument fields are incomplete for passenger ${passenger.passengerKey}` }),
                //         };
                //     }
                // }

                // contact validation
                const contact = passenger.contact;
                if (!contact || !Array.isArray(contact.contactsProvided) || contact.contactsProvided.length === 0) {
                    return {
                        ...globalHeaders(),
                        statusCode: 400,
                        body: JSON.stringify({ message: `contact information is required for passenger ${passenger.passengerKey}` }),
                    };
                }
                for (const c of contact.contactsProvided) {
                    if (!Array.isArray(c.emailAddress) || c.emailAddress.length === 0) {
                        return {
                            ...globalHeaders(),
                            statusCode: 400,
                            body: JSON.stringify({ message: `emailAddress is required for passenger ${passenger.passengerKey}` }),
                        };
                    }
                    if (!Array.isArray(c.phone) || c.phone.length === 0) {
                        return {
                            ...globalHeaders(),
                            statusCode: 400,
                            body: JSON.stringify({ message: `phone is required for passenger ${passenger.passengerKey}` }),
                        };
                    }
                    for (const p of c.phone) {
                        if (!p.label || !p.areaCode || !p.phoneNumber) {
                            return {
                                ...globalHeaders(),
                                statusCode: 400,
                                body: JSON.stringify({ message: `phone fields are incomplete for passenger ${passenger.passengerKey}` }),
                            };
                        }
                    }
                }
            }
        }

        if (!paymentDetails || typeof paymentDetails !== "object") {
            return {
                ...globalHeaders(),
                statusCode: 400,
                body: JSON.stringify({ message: "paymentDetails is required and must be an object" }),
            };
        }

        const { paymentMode } = paymentDetails;

        if (!paymentMode) {
            return {
                ...globalHeaders(),
                statusCode: 400,
                body: JSON.stringify({ message: "paymentMode is required in paymentDetails" }),
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

        // Prepare payload (never send sessionToken to supplier)
        const { sessionToken: _omitSession, unifiedSessionToken: _omitUnified, ...bookingFields } = body;
        const searchPayload = {
            ...bookingFields,
            clientReference: uuidv4(),
        };

        const supplierNet = supplierNetFromHold(preBookRow);
        if (supplierNet != null) {
            searchPayload.totalNet = supplierNet;
            if (searchPayload.paymentDetails?.transactionAmount != null) {
                searchPayload.paymentDetails.transactionAmount = supplierNet;
            }
            console.info("[HOTEL MARKUP] Provesio book net", {
                bookingKey,
                customerTotalNet: totalNet,
                supplierTotalNet: supplierNet,
            });
        } else {
            console.warn("[HOTEL MARKUP] Missing supplierTotalNet on hold; sending body totalNet to Provesio", {
                bookingKey,
                totalNet,
            });
        }

        console.log("searchPayload**********", searchPayload);

        // ---- CALL PROVESIO ----
        const searchResp = await axios.post(
            `${BASE_URL}/reservation/hotel-book`,
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
        console.log("searchResp original call *************", searchResp?.data);


        let responseData = searchResp?.data;

        // --- Handle async "FETCH LATER" response ---
        if (
            responseData?.meta?.statusCode === 2 &&
            responseData?.asyncFetch?.fetchUrl
        ) {
            console.log(
                "Received async response, starting poll for:",
                responseData.asyncFetch.fetchUrl
            );

            responseData = await pollAsyncResult(
                responseData.asyncFetch.fetchUrl,
                sessionId,
                conversationId
            );
        }

        await applyHotelMarkupsOnResponse(responseData);

        const payload = {
            id: uuidv4(),
            userId: authVerification?.context?.sub,
            userType: authVerification?.context?.userType,
            request: searchPayload,
            response: responseData?.data,
            stepCode: 110,
            hotelKey: hotelKey,
            status: "active"
        };

        await logTrace(payload);
        console.log("searchResp.data******************", responseData);

        const bookingData =
            Array.isArray(responseData)
                ? responseData[0]
                : Array.isArray(responseData?.data)
                    ? responseData.data[0]
                    : Array.isArray(responseData?.data?.data)
                        ? responseData.data.data[0]
                        : null;

        if (!bookingData) {
            throw new Error(`Invalid booking response: ${JSON.stringify(responseData)}`);
        }

        const hotelBookObj = {
            bookingReferenceId: bookingData.bookingReferenceId,
            hotelKey: hotelKey,
            supplierReferenceId: bookingData.supplierReferenceId,
            clientReference: bookingData.clientReference,
            bookingStatus: bookingData.bookingStatus,
            transactionDate: bookingData.transactionDate,
            hotel: JSON.stringify(bookingData.hotel),
            passengers: JSON.stringify(bookingData.passengers),
            userId: authVerification?.context?.sub,
            userType: authVerification?.context?.userType,
            searchKey: searchKey,
            sessionId: sessionId,
            conversationId: conversationId,
            request: JSON.stringify(body),
            fort_id: paymentRef,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        const dynamoString = (value) => {
            if (value === undefined || value === null) return undefined;
            const str = String(value);
            if (!str) return undefined;
            return { S: str };
        };
        const bookItem = Object.fromEntries(
            Object.entries({
                bookingReferenceId: dynamoString(hotelBookObj.bookingReferenceId),
                hotelKey: dynamoString(hotelBookObj.hotelKey),
                supplierReferenceId: dynamoString(hotelBookObj.supplierReferenceId),
                clientReference: dynamoString(hotelBookObj.clientReference),
                bookingStatus: dynamoString(hotelBookObj.bookingStatus),
                transactionDate: dynamoString(hotelBookObj.transactionDate),
                hotel: dynamoString(hotelBookObj.hotel),
                passengers: dynamoString(hotelBookObj.passengers),
                userId: dynamoString(hotelBookObj.userId),
                userType: dynamoString(hotelBookObj.userType),
                request: dynamoString(hotelBookObj.request),
                sessionId: dynamoString(hotelBookObj.sessionId),
                fort_id: dynamoString(hotelBookObj.fort_id),
                conversationId: dynamoString(hotelBookObj.conversationId),
                createdAt: dynamoString(hotelBookObj.createdAt),
                updatedAt: dynamoString(hotelBookObj.updatedAt),
                searchKey: dynamoString(searchKey),
                bookingKey: dynamoString(bookingKey),
            }).filter(([, attr]) => attr)
        );

        const putCmd = new PutItemCommand({
            TableName: process.env.HOTEL_BOOK_TABLE,
            Item: bookItem,
        });

        await dynamo.send(putCmd);

        const updateCmd = new UpdateItemCommand({
            TableName: process.env.HOTEL_PRE_BOOK_TABLE,
            Key: {
                bookingKey: { S: bookingKey }
            },
            UpdateExpression: "SET #bfi = :bookingReferenceId, #pas = :passengers, #st = :status",
            ExpressionAttributeNames: {
                "#bfi": "bookingReferenceId",
                "#pas": "passengers",
                "#st": "status"
            },
            ExpressionAttributeValues: {
                ":bookingReferenceId": { S: bookingData.bookingReferenceId },
                ":passengers": { S: JSON.stringify(bookingData.passengers) },
                ":status": { S: "confirmed" }
            }
        });
        await dynamo.send(updateCmd);

        if (unifiedSessionToken) {
            try {
                await markUnifiedSessionPaid(unifiedSessionToken);
            } catch (err) {
                console.warn(
                    "Failed to mark unified payment session paid:",
                    unifiedSessionToken,
                    err.message
                );
            }
        }

        if (Array.isArray(responseData)) {
            responseData[0].sessionId = sessionId;
            responseData[0].conversationId = conversationId;
        } else if (responseData?.data) {
            responseData.data.sessionId = sessionId;
            responseData.data.conversationId = conversationId;
        }

        // await removedConverationId(authVerification?.context?.sub, searchKey)

        if (isHotelSupplierConfirmed(bookingData.bookingStatus)) {
            await enqueueHotelBookingEmail({
                hotelBookingData: {
                    data: [{
                        ...bookingData,
                        hotel: {
                            ...(bookingData.hotel || {}),
                            hotelKey: bookingData.hotel?.hotelKey || hotelKey,
                        },
                    }],
                },
                userId: authVerification?.context?.sub,
                userType: authVerification?.context?.userType,
            });
        } else {
            console.log(
                "Skipping hotel confirmation email until supplier confirms. bookingStatus:",
                bookingData.bookingStatus
            );
        }

        return {
            statusCode: 200,
            ...globalHeaders(),
            body: JSON.stringify(responseData),
        };
    } catch (error) {
        console.error("Error in hotel pre book:", error.response?.data || error.message, error.stack);
        return await InternalError(error);
    }
};
