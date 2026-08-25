import { v4 as uuidv4 } from "uuid";
import { globalHeaders, InternalError } from "../helper/helper.js";
import { verifyToken } from "./authorizerLayer.js";
import {
    buildPreBookDataFromRow,
    getPreBookRow,
    isPastExpiry,
    preBookExpiresAt,
    savePaymentSession,
    searchKeyFromPreBook,
    ttlEpochSeconds,
} from "../lib/hotelPaymentSession.js";

export const handler = async (event) => {
    try {
        const authVerification = await verifyToken(event);
        if (authVerification?.principalId === "unknown") {
            return {
                ...globalHeaders(),
                statusCode: 401,
                body: JSON.stringify({ message: "Unauthorized: Invalid or expired token" }),
            };
        }

        if (authVerification?.context?.userType === "guest") {
            return {
                ...globalHeaders(),
                statusCode: 401,
                body: JSON.stringify({
                    message: "Unauthorized: Guest User is not allowed for hotel booking",
                }),
            };
        }

        const body = typeof event.body === "string" ? JSON.parse(event.body) : event.body || {};
        const {
            bookingKey,
            hotelKey,
            searchKey,
            hotelBookingPayload,
            preBookData,
            hotelDetail,
            totalPrice,
            currency,
        } = body;

        if (!bookingKey) {
            return {
                ...globalHeaders(),
                statusCode: 400,
                body: JSON.stringify({ message: "bookingKey is required" }),
            };
        }

        if (!hotelBookingPayload || typeof hotelBookingPayload !== "object") {
            return {
                ...globalHeaders(),
                statusCode: 400,
                body: JSON.stringify({ message: "hotelBookingPayload is required" }),
            };
        }

        const preBook = await getPreBookRow(bookingKey);
        if (!preBook) {
            return {
                ...globalHeaders(),
                statusCode: 404,
                body: JSON.stringify({ message: "Pre-book not found" }),
            };
        }

        if (preBook.userId !== authVerification.context.sub) {
            return {
                ...globalHeaders(),
                statusCode: 403,
                body: JSON.stringify({ message: "Forbidden: booking does not belong to this user" }),
            };
        }

        if (preBook.status !== "pending") {
            return {
                ...globalHeaders(),
                statusCode: 410,
                body: JSON.stringify({ message: "Pre-book is no longer pending", code: "EXPIRED" }),
            };
        }

        const expiresAt = preBookExpiresAt(preBook.createdAt);
        if (isPastExpiry(expiresAt)) {
            return {
                ...globalHeaders(),
                statusCode: 410,
                body: JSON.stringify({ message: "Pre-book has expired", code: "EXPIRED" }),
            };
        }

        const resolvedSearchKey = searchKey || searchKeyFromPreBook(preBook);
        const resolvedHotelKey = hotelKey || preBook.hotelKey;
        const snapshot = {
            hotelKey: resolvedHotelKey,
            searchKey: resolvedSearchKey,
            bookingKey,
            preBookData: preBookData || buildPreBookDataFromRow(preBook),
            hotelBookingPayload,
            totalPrice: totalPrice ?? Number(preBook.totalNet),
            currency: currency || preBook.currency,
            hotelDetail: hotelDetail || null,
        };

        const paymentToken = uuidv4();
        const now = new Date().toISOString();

        await savePaymentSession({
            paymentToken: { S: paymentToken },
            bookingKey: { S: bookingKey },
            userId: { S: authVerification.context.sub },
            status: { S: "pending" },
            expiresAt: { S: expiresAt },
            ttl: { N: String(ttlEpochSeconds(expiresAt)) },
            snapshot: { S: JSON.stringify(snapshot) },
            createdAt: { S: now },
            updatedAt: { S: now },
        });

        return {
            statusCode: 200,
            ...globalHeaders(),
            body: JSON.stringify({
                paymentToken,
                expiresAt,
                paymentUrlPath: `/hotel-payment?token=${paymentToken}`,
            }),
        };
    } catch (error) {
        console.error("Error in createHotelPaymentSession:", error.message, error.stack);
        return await InternalError(error);
    }
};
