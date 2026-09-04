import { globalHeaders, InternalError } from "../helper/helper.js";
import { verifyToken } from "./authorizerLayer.js";
import {
    parsePaymentSessionBody,
    preparePaymentSessionRequest,
} from "../lib/hotelPaymentSession.js";
import { createUnifiedPaymentSession } from "../lib/unifiedSessionClient.js";

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

        const body = parsePaymentSessionBody(event);
        const prepared = await preparePaymentSessionRequest(authVerification, body);
        if (!prepared.ok) {
            return {
                ...globalHeaders(),
                statusCode: prepared.statusCode,
                body: JSON.stringify(prepared.body),
            };
        }

        const { bookingKey, snapshot, expiresAt } = prepared;

        const unified = await createUnifiedPaymentSession({
            product: "hotel",
            bookingId: bookingKey,
            snapshot,
            paymentDetails: {
                amount: snapshot.totalPrice,
                currency: snapshot.currency,
            },
        });

        return {
            statusCode: 200,
            ...globalHeaders(),
            body: JSON.stringify({
                sessionToken: unified.sessionToken,
                expiresAt: unified.expiresAt ?? expiresAt,
                bookingId: bookingKey,
                reused: Boolean(unified.reused),
            }),
        };
    } catch (error) {
        console.error("Error in createHotelUnifiedPaymentSession:", error.message, error.stack);
        if (error.statusCode) {
            return {
                ...globalHeaders(),
                statusCode: error.statusCode,
                body: JSON.stringify({
                    message: error.message,
                    code: error.code,
                }),
            };
        }
        return await InternalError(error);
    }
};
