import axios from "axios";
import { computeTTLFromSupplier, enqueueHotelBookingEmail, getSessionId, globalHeaders, InternalError, isHotelSupplierConfirmed, logTrace, removedConverationId } from "../helper/helper.js";
import { enqueuePendingHotelPoll, isHotelPendingPollStatus } from "../helper/hotelPendingPoll.js";
import { markHotelConfirmationEmailQueued } from "../helper/hotelBookingStatusSync.js";
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
import { redeemMarkupsPromo } from "../helper/markupsPromoClient.js";
import {
    attachBoundPromoToHotelHold,
} from "../helper/applyHotelPromo.js";
import {
    foldPromoOntoHotelTotal,
    stringifyPromo,
} from "../helper/hotelPromoBind.js";

const dynamo = new DynamoDBClient({ region: process.env.REGION });

/** Internal FE/BFF fields — never forward to Provesio hotel-book. */
const PROVESIO_BOOK_OMIT = new Set([
    "sessionToken",
    "unifiedSessionToken",
    "paymentReference",
    "customerInfo",
]);

const isBlank = (value) =>
    value == null || (typeof value === "string" && value.trim() === "");

const sanitizeIdentityDocuments = (docs) => {
    if (!Array.isArray(docs)) return undefined;
    const cleaned = docs
        .map((doc) => {
            if (!doc || typeof doc !== "object") return null;
            const next = {};
            for (const [key, value] of Object.entries(doc)) {
                if (isBlank(value)) continue;
                next[key] = value;
            }
            return Object.keys(next).length ? next : null;
        })
        .filter(Boolean);
    return cleaned.length ? cleaned : undefined;
};

const sanitizeHotelBookPassenger = (passenger) => {
    if (!passenger || typeof passenger !== "object") return passenger;
    const next = { ...passenger };
    const docs = sanitizeIdentityDocuments(passenger.identityDocuments);
    if (docs) next.identityDocuments = docs;
    else delete next.identityDocuments;
    return next;
};

/** Shape the Provesio hotel-book body without mutating the FE request we persist. */
const buildProvesioHotelBookPayload = (body, { supplierNet, clientReference }) => {
    const payload = {};
    for (const [key, value] of Object.entries(body || {})) {
        if (PROVESIO_BOOK_OMIT.has(key)) continue;
        payload[key] = value;
    }
    if (isBlank(payload.userSelectedArrivalTime)) {
        delete payload.userSelectedArrivalTime;
    }
    if (Array.isArray(payload.rooms)) {
        payload.rooms = payload.rooms.map((room) => {
            if (!room || typeof room !== "object") return room;
            const next = { ...room };
            if (Array.isArray(room.passengers)) {
                next.passengers = room.passengers.map(sanitizeHotelBookPassenger);
            }
            return next;
        });
    }
    if (payload.paymentDetails && typeof payload.paymentDetails === "object") {
        payload.paymentDetails = { ...payload.paymentDetails };
    }
    payload.clientReference = clientReference;
    if (supplierNet != null) {
        payload.totalNet = supplierNet;
        if (payload.paymentDetails?.transactionAmount != null) {
            payload.paymentDetails.transactionAmount = supplierNet;
        }
    }
    return payload;
};

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

        const supplierNet = supplierNetFromHold(preBookRow);
        const searchPayload = buildProvesioHotelBookPayload(body, {
            supplierNet,
            clientReference: uuidv4(),
        });
        if (supplierNet != null) {
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

        const userId = authVerification?.context?.sub;
        const attach = await attachBoundPromoToHotelHold({
            preBook: preBookRow,
            userId,
            bookingKey,
        });
        const promo = attach.promo;
        if (attach.promoDropped) {
            console.warn("[HOTEL PROMO] dropped at book", attach.promoDropped);
        }

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

        if (promo && bookingData.hotel) {
            foldPromoOntoHotelTotal(bookingData.hotel, promo);
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
                promo: dynamoString(stringifyPromo(promo)),
            }).filter(([, attr]) => attr)
        );

        const putCmd = new PutItemCommand({
            TableName: process.env.HOTEL_BOOK_TABLE,
            Item: bookItem,
        });

        await dynamo.send(putCmd);

        const promoAttr = stringifyPromo(promo);
        const updateCmd = new UpdateItemCommand({
            TableName: process.env.HOTEL_PRE_BOOK_TABLE,
            Key: {
                bookingKey: { S: bookingKey }
            },
            UpdateExpression: promoAttr
                ? "SET #bfi = :bookingReferenceId, #pas = :passengers, #st = :status, #prm = :promo"
                : "SET #bfi = :bookingReferenceId, #pas = :passengers, #st = :status",
            ExpressionAttributeNames: promoAttr
                ? {
                    "#bfi": "bookingReferenceId",
                    "#pas": "passengers",
                    "#st": "status",
                    "#prm": "promo"
                }
                : {
                    "#bfi": "bookingReferenceId",
                    "#pas": "passengers",
                    "#st": "status"
                },
            ExpressionAttributeValues: promoAttr
                ? {
                    ":bookingReferenceId": { S: bookingData.bookingReferenceId },
                    ":passengers": { S: JSON.stringify(bookingData.passengers) },
                    ":status": { S: "confirmed" },
                    ":promo": { S: promoAttr }
                }
                : {
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

        if (promo) {
            bookingData.promo = promo;
        }
        if (attach.promoDropped) {
            bookingData.promoDropped = attach.promoDropped;
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
            if (promo?.code) {
                try {
                    const redeemed = await redeemMarkupsPromo({
                        code: promo.code,
                        userId,
                        bookingId: bookingData.bookingReferenceId,
                        discount: promo.discount,
                        payable: promo.payable,
                        listedPrice: promo.listedPrice,
                    });
                    if (!redeemed.ok) {
                        console.warn("[HOTEL PROMO] redeem failed", redeemed.message);
                    }
                } catch (redeemErr) {
                    console.warn("[HOTEL PROMO] redeem error", redeemErr?.message);
                }
            }
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
            try {
                await markHotelConfirmationEmailQueued(
                    dynamo,
                    bookingData.bookingReferenceId,
                    hotelKey
                );
            } catch (stampErr) {
                console.warn(
                    "confirmationEmailQueuedAt stamp skipped:",
                    bookingData.bookingReferenceId,
                    stampErr?.message
                );
            }
        } else if (isHotelPendingPollStatus(bookingData.bookingStatus)) {
            console.log(
                "Skipping hotel confirmation email until supplier confirms. bookingStatus:",
                bookingData.bookingStatus
            );
            try {
                await enqueuePendingHotelPoll({
                    bookingReferenceId: bookingData.bookingReferenceId,
                    hotelKey,
                    bookingKey,
                    searchKey,
                    clientReferenceId: bookingData.clientReference || "",
                    userId: authVerification?.context?.sub,
                    userType: authVerification?.context?.userType,
                    lastKnownStatus: bookingData.bookingStatus,
                    enqueuedAt: hotelBookObj.createdAt,
                });
            } catch (pollErr) {
                console.error(
                    "Failed to enqueue hotel pending poll:",
                    bookingData.bookingReferenceId,
                    pollErr?.message
                );
            }
        } else {
            console.log(
                "Booking status not confirmed and not pollable:",
                bookingData.bookingStatus
            );
        }

        return {
            statusCode: 200,
            ...globalHeaders(),
            body: JSON.stringify(responseData),
        };
    } catch (error) {
        console.error("Error in hotel booking:", error.response?.data || error.message, error.stack);
        return await InternalError(error);
    }
};
