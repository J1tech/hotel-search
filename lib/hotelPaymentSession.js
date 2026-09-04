import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { markUnifiedSessionPaid } from "./unifiedSessionClient.js";

export { markUnifiedSessionPaid };

const dynamo = new DynamoDBClient({ region: process.env.REGION });

export const PREBOOK_HOLD_MS = 15 * 60 * 1000;

export function preBookExpiresAt(createdAt) {
    return new Date(new Date(createdAt).getTime() + PREBOOK_HOLD_MS).toISOString();
}

export function isPastExpiry(expiresAt) {
    return Date.now() >= new Date(expiresAt).getTime();
}

export async function getPreBookRow(bookingKey) {
    const result = await dynamo.send(
        new GetItemCommand({
            TableName: process.env.HOTEL_PRE_BOOK_TABLE,
            Key: { bookingKey: { S: bookingKey } },
        })
    );
    return result.Item ? unmarshall(result.Item) : null;
}

export function buildPreBookDataFromRow(preBook) {
    return {
        bookingKey: preBook.bookingKey,
        hotelKey: preBook.hotelKey,
        name: preBook.name,
        totalNet: preBook.totalNet,
        currency: preBook.currency,
        checkInDate: preBook.checkInDate,
        checkOutDate: preBook.checkOutDate,
        priceChangeIndicator: preBook.priceChangeIndicator,
        rooms: tryParseJson(preBook.rooms),
        verifiedPropertyInfo: tryParseJson(preBook.verifiedPropertyInfo),
        mandatoryBookData: tryParseJson(preBook.mandatoryBookData),
    };
}

function tryParseJson(value) {
    if (typeof value !== "string") return value;
    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
}

export function searchKeyFromPreBook(preBook) {
    const request = tryParseJson(preBook.request);
    return request?.searchKey ?? null;
}

export function parsePaymentSessionBody(event) {
    return typeof event.body === "string" ? JSON.parse(event.body) : event.body || {};
}

export function buildPaymentSnapshot({ preBook, body, bookingKey }) {
    const {
        hotelKey,
        searchKey,
        hotelBookingPayload,
        preBookData,
        hotelDetail,
        totalPrice,
        currency,
    } = body;

    const resolvedSearchKey = searchKey || searchKeyFromPreBook(preBook);
    const resolvedHotelKey = hotelKey || preBook.hotelKey;

    return {
        hotelKey: resolvedHotelKey,
        searchKey: resolvedSearchKey,
        bookingKey,
        preBookData: preBookData || buildPreBookDataFromRow(preBook),
        hotelBookingPayload,
        totalPrice: totalPrice ?? Number(preBook.totalNet),
        currency: currency || preBook.currency,
        hotelDetail: hotelDetail || null,
    };
}

/**
 * Validates auth + pre-book state and builds the payment snapshot.
 * @returns {{ ok: true, bookingKey, snapshot, expiresAt, preBook } | { ok: false, statusCode, body }}
 */
export async function preparePaymentSessionRequest(authVerification, body) {
    const { bookingKey, hotelBookingPayload } = body;

    if (!bookingKey) {
        return {
            ok: false,
            statusCode: 400,
            body: { message: "bookingKey is required" },
        };
    }

    if (!hotelBookingPayload || typeof hotelBookingPayload !== "object") {
        return {
            ok: false,
            statusCode: 400,
            body: { message: "hotelBookingPayload is required" },
        };
    }

    const preBook = await getPreBookRow(bookingKey);
    if (!preBook) {
        return {
            ok: false,
            statusCode: 404,
            body: { message: "Pre-book not found" },
        };
    }

    if (preBook.userId !== authVerification.context.sub) {
        return {
            ok: false,
            statusCode: 403,
            body: { message: "Forbidden: booking does not belong to this user" },
        };
    }

    if (preBook.status !== "pending") {
        return {
            ok: false,
            statusCode: 410,
            body: { message: "Pre-book is no longer pending", code: "EXPIRED" },
        };
    }

    const expiresAt = preBookExpiresAt(preBook.createdAt);
    if (isPastExpiry(expiresAt)) {
        return {
            ok: false,
            statusCode: 410,
            body: { message: "Pre-book has expired", code: "EXPIRED" },
        };
    }

    const snapshot = buildPaymentSnapshot({ preBook, body, bookingKey });

    return {
        ok: true,
        bookingKey,
        snapshot,
        expiresAt,
        preBook,
    };
}
