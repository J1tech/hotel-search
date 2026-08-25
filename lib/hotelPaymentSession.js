import {
    DynamoDBClient,
    GetItemCommand,
    PutItemCommand,
    UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";

const dynamo = new DynamoDBClient({ region: process.env.REGION });

export const PREBOOK_HOLD_MS = 15 * 60 * 1000;

export function preBookExpiresAt(createdAt) {
    return new Date(new Date(createdAt).getTime() + PREBOOK_HOLD_MS).toISOString();
}

export function isPastExpiry(expiresAt) {
    return Date.now() >= new Date(expiresAt).getTime();
}

export function ttlEpochSeconds(expiresAt) {
    return Math.floor(new Date(expiresAt).getTime() / 1000) + 24 * 60 * 60;
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

export async function getPaymentSession(paymentToken) {
    const result = await dynamo.send(
        new GetItemCommand({
            TableName: process.env.HOTEL_PAYMENT_SESSION_TABLE,
            Key: { paymentToken: { S: paymentToken } },
        })
    );
    if (!result.Item) return null;

    const session = unmarshall(result.Item);
    if (typeof session.snapshot === "string") {
        try {
            session.snapshot = JSON.parse(session.snapshot);
        } catch {
            // leave as string if invalid
        }
    }
    return session;
}

export async function savePaymentSession(item) {
    await dynamo.send(
        new PutItemCommand({
            TableName: process.env.HOTEL_PAYMENT_SESSION_TABLE,
            Item: item,
        })
    );
}

export async function markSessionExpired(paymentToken) {
    const now = new Date().toISOString();
    await dynamo.send(
        new UpdateItemCommand({
            TableName: process.env.HOTEL_PAYMENT_SESSION_TABLE,
            Key: { paymentToken: { S: paymentToken } },
            UpdateExpression: "SET #st = :expired, updatedAt = :now",
            ExpressionAttributeNames: { "#st": "status" },
            ExpressionAttributeValues: {
                ":expired": { S: "expired" },
                ":now": { S: now },
            },
        })
    );
}

export async function markSessionPaid(paymentToken) {
    const now = new Date().toISOString();
    await dynamo.send(
        new UpdateItemCommand({
            TableName: process.env.HOTEL_PAYMENT_SESSION_TABLE,
            Key: { paymentToken: { S: paymentToken } },
            UpdateExpression: "SET #st = :paid, updatedAt = :now",
            ExpressionAttributeNames: { "#st": "status" },
            ExpressionAttributeValues: {
                ":paid": { S: "paid" },
                ":now": { S: now },
            },
        })
    );
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
