import { PutCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { dynamoDb } from "../lib/dynamoDbClient.js";

const TABLE_NAME = process.env.HOTEL_CANCELLATION_POLICY_TABLE;

export const saveHotelCancellationPolicy = async ({
    hotelKey,
    searchKey,
    data,
    commonData,
    meta,
}) => {
    const now = Math.floor(Date.now() / 1000);

    // Example: keep policy for 24 hours.
    // You can replace this with computeTTLFromSupplier().
    const ttl = now + (24 * 60 * 60);

    const item = {
        hotelKey,
        searchKey,

        data,

        commonData: commonData || null,
        meta: meta || null,

        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),

        ttl,
    };

    await dynamoDb.send(
        new PutCommand({
            TableName: TABLE_NAME,
            Item: item,
        })
    );

    return item;
};

export const getHotelCancellationPolicy = async ({
    hotelKey,
    searchKey,
}) => {
    const result = await dynamoDb.send(
        new GetCommand({
            TableName: TABLE_NAME,
            Key: {
                hotelKey,
                searchKey,
            },
        })
    );

    return result.Item || null;
};