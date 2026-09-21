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
import {
    loadCheckoutById,
    patchCheckoutSnapshot,
    requireCapturedNgeniusOrder,
    stampConfirmInProgress,
} from "../lib/hotelCheckout.js";
import { summarizeNgeniusPayment } from "../lib/ngeniusPaymentState.js";
import { redeemMarkupsPromo } from "../helper/markupsPromoClient.js";
import {
    attachBoundPromoToHotelHold,
} from "../helper/applyHotelPromo.js";
import {
    foldPromoOntoHotelTotal,
    stringifyPromo,
} from "../helper/hotelPromoBind.js";
import {
    isHotelFetchLater,
    isTransientHotelBookError,
    pollHotelBookFetchLater,
} from "../helper/hotelAsyncFetch.js";
import { isHotelTerminalStopStatus } from "../helper/hotelPendingPoll.js";
import { sendHotelOpsAlert } from "../lib/opsBookingAlert.js";

const dynamo = new DynamoDBClient({ region: process.env.REGION });

async function emitHotelOpsAlert(params, label) {
    try {
        await sendHotelOpsAlert(params);
    } catch (err) {
        console.warn(`hotel ops alert (${label}) failed:`, err?.message || err);
    }
}

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

const sanitizePassengerContact = (contact, { isLead = false } = {}) => {
    if (!contact || !Array.isArray(contact.contactsProvided)) return isLead ? contact : undefined;
    const cleanedProvided = contact.contactsProvided
        .map((entry) => {
            if (!entry || typeof entry !== "object") return null;
            const phones = (Array.isArray(entry.phone) ? entry.phone : [])
                .filter((p) => p && !isBlank(p.areaCode) && !isBlank(p.phoneNumber))
                .map((p) => ({
                    ...p,
                    label: isBlank(p.label) ? "Origin" : p.label,
                }));
            const emails = (Array.isArray(entry.emailAddress) ? entry.emailAddress : []).filter(
                (e) => !isBlank(e),
            );
            if (!phones.length && !emails.length) return null;
            const next = {};
            if (emails.length) next.emailAddress = emails;
            if (phones.length) next.phone = phones;
            return next;
        })
        .filter(Boolean);
    if (!cleanedProvided.length) return isLead ? contact : undefined;
    return { contactsProvided: cleanedProvided };
};

const sanitizeHotelBookPassenger = (passenger) => {
    if (!passenger || typeof passenger !== "object") return passenger;
    const next = { ...passenger };
    const docs = sanitizeIdentityDocuments(passenger.identityDocuments);
    if (docs) next.identityDocuments = docs;
    else delete next.identityDocuments;
    const contact = sanitizePassengerContact(passenger.contact, { isLead: passenger.isLead === true });
    if (contact) next.contact = contact;
    else delete next.contact;
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
const PROVESIO_BOOK_TIMEOUT_MS = 75000;

const confirmInProgressBody = (extra = {}) => ({
    message: "Booking confirmation already in progress",
    code: "CONFIRM_IN_PROGRESS",
    ...extra,
});

export const handler = async (event, context) => {
    try {
        console.log("BASE_URL********************", BASE_URL);

        const rawBody = typeof event.body === "string" ? JSON.parse(event.body) : event.body;
        const unifiedSessionToken =
            rawBody?.sessionToken ?? rawBody?.unifiedSessionToken ?? null;
        let checkoutRecord = null;
        let ngeniusOrder = null;

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

                // Lead guest must have email + phone; additional guests may omit contact.
                const contact = passenger.contact;
                const isLead = passenger.isLead === true;
                if (isLead) {
                    if (!contact || !Array.isArray(contact.contactsProvided) || contact.contactsProvided.length === 0) {
                        return {
                            ...globalHeaders(),
                            statusCode: 400,
                            body: JSON.stringify({ message: `contact information is required for passenger ${passenger.passengerKey}` }),
                        };
                    }
                    for (const c of contact.contactsProvided) {
                        if (!Array.isArray(c.emailAddress) || c.emailAddress.length === 0 || isBlank(c.emailAddress[0])) {
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
                            if (isBlank(p.label) || isBlank(p.areaCode) || isBlank(p.phoneNumber)) {
                                return {
                                    ...globalHeaders(),
                                    statusCode: 400,
                                    body: JSON.stringify({ message: `phone fields are incomplete for passenger ${passenger.passengerKey}` }),
                                };
                            }
                        }
                    }
                } else if (contact && Array.isArray(contact.contactsProvided)) {
                    for (const c of contact.contactsProvided) {
                        for (const p of c.phone || []) {
                            if (isBlank(p?.areaCode) && isBlank(p?.phoneNumber)) continue;
                            if (isBlank(p.label) || isBlank(p.areaCode) || isBlank(p.phoneNumber)) {
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

        const checkoutId = String(rawBody?.checkoutId || "").trim();
        const paymentReference = String(
            rawBody?.paymentReference || rawBody?.orderReference || paymentRef || "",
        ).trim();
        if (checkoutId) {
            checkoutRecord = await loadCheckoutById(checkoutId);
            if (!checkoutRecord?.checkoutId) {
                return {
                    ...globalHeaders(),
                    statusCode: 404,
                    body: JSON.stringify({ message: "Checkout not found", code: "NOT_FOUND" }),
                };
            }
            if (checkoutRecord.bookingKey && checkoutRecord.bookingKey !== bookingKey) {
                return {
                    ...globalHeaders(),
                    statusCode: 409,
                    body: JSON.stringify({
                        message: "Checkout does not match this booking.",
                        code: "PAYMENT_REFERENCE_MISMATCH",
                    }),
                };
            }
            if (checkoutRecord.orderReference && paymentReference && checkoutRecord.orderReference !== paymentReference) {
                return {
                    ...globalHeaders(),
                    statusCode: 409,
                    body: JSON.stringify({
                        message: "Payment reference does not match this checkout.",
                        code: "PAYMENT_REFERENCE_MISMATCH",
                    }),
                };
            }
            if (checkoutRecord.bookingReference) {
                return {
                    ...globalHeaders(),
                    statusCode: 409,
                    body: JSON.stringify({
                        message: "Booking already confirmed",
                        code: "ALREADY_BOOKED",
                        bookingReferenceId: checkoutRecord.bookingReference,
                    }),
                };
            }
            try {
                ngeniusOrder = await requireCapturedNgeniusOrder({
                    orderReference: paymentReference || checkoutRecord.orderReference,
                    amount: checkoutRecord.amount,
                });
            } catch (err) {
                return {
                    ...globalHeaders(),
                    statusCode: err.statusCode || 402,
                    body: JSON.stringify({
                        message: err.message,
                        code: err.code,
                        paymentStatus: err.paymentStatus,
                    }),
                };
            }
            try {
                await stampConfirmInProgress(checkoutId);
            } catch (err) {
                return {
                    ...globalHeaders(),
                    statusCode: err.statusCode || 409,
                    body: JSON.stringify({ message: err.message, code: err.code }),
                };
            }
        } else if (String(process.env.HOTEL_HPP_REQUIRED || "").toLowerCase() === "true") {
            return {
                ...globalHeaders(),
                statusCode: 402,
                body: JSON.stringify({
                    message: "Payment has not been completed.",
                    code: "PAYMENT_NOT_CAPTURED",
                    paymentStatus: "none",
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

        const remainingMs = Number(context?.getRemainingTimeInMillis?.() || 90000);
        const bookDeadline = Date.now() + Math.max(20000, remainingMs - 8000);
        const provesioTimeout = Math.min(
            PROVESIO_BOOK_TIMEOUT_MS,
            Math.max(15000, bookDeadline - Date.now() - 5000),
        );

        // ---- CALL PROVESIO ----
        const searchResp = await axios.post(
            `${BASE_URL}/reservation/hotel-book`,
            searchPayload,
            {
                timeout: provesioTimeout,
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

        // FETCH LATER: follow fetchUrl in this Lambda (it keeps running after API GW 504).
        // Do not throw if time runs out — keep confirmStatus=in_progress so FE GET-polls.
        if (isHotelFetchLater(responseData)) {
            console.log(
                "Received async hotel-book response, polling:",
                responseData.asyncFetch.fetchUrl
            );
            const polled = await pollHotelBookFetchLater({
                fetchUrl: responseData.asyncFetch.fetchUrl,
                sessionId,
                conversationId,
                deadlineMs: bookDeadline,
            });
            if (!polled) {
                await emitHotelOpsAlert({
                    scenario: "booking_pending",
                    record: checkoutRecord,
                    reason: "hotel_book_fetch_later_in_progress",
                    extra: { fetchUrl: responseData.asyncFetch.fetchUrl, bookingKey, searchKey },
                }, "fetch later");
                return {
                    statusCode: 202,
                    ...globalHeaders(),
                    body: JSON.stringify(confirmInProgressBody({ fetchUrl: responseData.asyncFetch.fetchUrl })),
                };
            }
            responseData = polled;
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

        const ngeniusPayment = ngeniusOrder ? summarizeNgeniusPayment(ngeniusOrder) : null;
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
                checkoutId: dynamoString(checkoutId),
                checkoutSnapshot: dynamoString(
                    checkoutRecord?.snapshot && Object.keys(checkoutRecord.snapshot).length
                        ? JSON.stringify(checkoutRecord.snapshot)
                        : "",
                ),
                ngeniusPayment: dynamoString(
                    ngeniusPayment ? JSON.stringify(ngeniusPayment) : "",
                ),
                chargedAmount:
                    checkoutRecord?.amount != null
                        ? { N: String(checkoutRecord.amount) }
                        : undefined,
                chargedCurrency: dynamoString(checkoutRecord?.currency),
                paymentStatus: dynamoString(ngeniusPayment?.mappedStatus || checkoutRecord?.paymentStatus),
                paymentMode: dynamoString(
                    ngeniusPayment?.action ||
                        ngeniusPayment?.paymentMethod?.type ||
                        paymentMode,
                ),
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

        if (checkoutRecord?.bookingKey) {
            try {
                await patchCheckoutSnapshot(checkoutRecord.bookingKey, {
                    confirmStatus: "confirmed",
                    paymentStatus: "captured",
                });
            } catch (stampErr) {
                console.warn("Failed to stamp hotel checkout confirmed:", stampErr?.message || stampErr);
            }
        }

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
            const emailQueued = await enqueueHotelBookingEmail({
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
            if (emailQueued) {
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
            } else {
                console.error(
                    "Hotel confirmation email was not queued; not stamping confirmationEmailQueuedAt:",
                    bookingData.bookingReferenceId
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
            await emitHotelOpsAlert({
                scenario: "booking_pending",
                record: checkoutRecord,
                bookingRecord: hotelBookObj,
                supplierStatus: bookingData.bookingStatus,
                reason: "supplier_pending_after_book",
            }, "pending poll");
        } else {
            console.log(
                "Booking status not confirmed and not pollable:",
                bookingData.bookingStatus
            );
            await emitHotelOpsAlert({
                scenario: isHotelTerminalStopStatus(bookingData.bookingStatus)
                    ? "supplier_failed"
                    : "booking_failed",
                record: checkoutRecord,
                bookingRecord: hotelBookObj,
                supplierStatus: bookingData.bookingStatus,
                reason: "supplier_status_not_confirmed",
            }, "non-pollable status");
        }

        return {
            statusCode: 200,
            ...globalHeaders(),
            body: JSON.stringify(responseData),
        };
    } catch (error) {
        console.error("Error in hotel booking:", error.response?.data || error.message, error.stack);
        const transient = isTransientHotelBookError(error);
        if (transient) {
            return {
                statusCode: 202,
                ...globalHeaders(),
                body: JSON.stringify(confirmInProgressBody()),
            };
        }
        try {
            if (typeof checkoutRecord !== "undefined" && checkoutRecord?.bookingKey) {
                await patchCheckoutSnapshot(checkoutRecord.bookingKey, {
                    confirmStatus: "confirm_failed",
                    confirmStartedAt: "",
                });
            }
        } catch (stampErr) {
            console.warn("Failed to stamp hotel checkout confirm_failed:", stampErr?.message || stampErr);
        }
        if (ngeniusOrder && checkoutRecord) {
            await emitHotelOpsAlert({
                scenario: "booking_failed",
                record: checkoutRecord,
                reason: "hotel_confirm_failed",
                error,
            }, "confirm_failed");
        }
        if (error?.code && error?.statusCode) {
            return {
                ...globalHeaders(),
                statusCode: error.statusCode,
                body: JSON.stringify({
                    message: error.message,
                    code: error.code,
                    paymentStatus: error.paymentStatus,
                }),
            };
        }
        return await InternalError(error);
    }
};
