import { globalHeaders, InternalError } from "../helper/helper.js";
import {
    getPaymentSession,
    getPreBookRow,
    isPastExpiry,
    markSessionExpired,
} from "../lib/hotelPaymentSession.js";

export const handler = async (event) => {
    try {
        const paymentToken = event.pathParameters?.token;
        if (!paymentToken) {
            return {
                ...globalHeaders(),
                statusCode: 400,
                body: JSON.stringify({ message: "token is required" }),
            };
        }

        const session = await getPaymentSession(paymentToken);
        if (!session) {
            return {
                ...globalHeaders(),
                statusCode: 404,
                body: JSON.stringify({
                    message: "Payment link not found",
                    code: "NOT_FOUND",
                }),
            };
        }

        if (session.status === "paid") {
            return {
                ...globalHeaders(),
                statusCode: 410,
                body: JSON.stringify({ code: "PAID", status: "paid", message: "Already paid" }),
            };
        }

        if (session.status === "expired" || isPastExpiry(session.expiresAt)) {
            if (session.status !== "expired") {
                await markSessionExpired(paymentToken);
            }
            return {
                ...globalHeaders(),
                statusCode: 410,
                body: JSON.stringify({
                    code: "EXPIRED",
                    status: "expired",
                    message: "Payment link has expired",
                }),
            };
        }

        const preBook = await getPreBookRow(session.bookingKey);
        if (!preBook || preBook.status !== "pending") {
            await markSessionExpired(paymentToken);
            return {
                ...globalHeaders(),
                statusCode: 410,
                body: JSON.stringify({
                    code: "EXPIRED",
                    status: "expired",
                    message: "Payment link has expired",
                }),
            };
        }

        return {
            statusCode: 200,
            ...globalHeaders(),
            body: JSON.stringify({
                status: session.status,
                expiresAt: session.expiresAt,
                snapshot: session.snapshot,
            }),
        };
    } catch (error) {
        console.error("Error in getHotelPaymentSession:", error.message, error.stack);
        return await InternalError(error);
    }
};
