import {
    DynamoDBClient,
    GetItemCommand,
} from "@aws-sdk/client-dynamodb";

import {
    globalHeaders,
    InternalError,
} from "../helper/helper.js";


const dynamo = new DynamoDBClient({
    region: process.env.REGION,
});

const TABLE_NAME =
    process.env.HOTEL_CANCELLATION_POLICY_TABLE;

export const handler = async (event) => {
    try {
        
        // --------------------------------------------------
        // REQUEST BODY
        // --------------------------------------------------
        const body =
            typeof event.body === "string"
                ? JSON.parse(event.body)
                : event.body;

        const {
            hotelKey,
            searchKey,
        } = body || {};

        // --------------------------------------------------
        // VALIDATION
        // --------------------------------------------------
        if (!hotelKey) {
            return {
                ...globalHeaders(),
                statusCode: 400,
                body: JSON.stringify({
                    message: "hotelKey is required",
                }),
            };
        }

        if (!searchKey) {
            return {
                ...globalHeaders(),
                statusCode: 400,
                body: JSON.stringify({
                    message: "searchKey is required",
                }),
            };
        }

        // --------------------------------------------------
        // GET FROM DYNAMODB
        // --------------------------------------------------
        const command = new GetItemCommand({
            TableName: TABLE_NAME,

            Key: {
                hotelKey: {
                    S: hotelKey,
                },
                searchKey: {
                    S: searchKey,
                },
            },
        });

        const result = await dynamo.send(command);

        // --------------------------------------------------
        // NOT FOUND
        // --------------------------------------------------
        if (!result.Item) {
            return {
                ...globalHeaders(),
                statusCode: 404,
                body: JSON.stringify({
                    message:
                        "Hotel cancellation policy not found",
                    hotelKey,
                    searchKey,
                }),
            };
        }

        // --------------------------------------------------
        // CONVERT DYNAMODB DATA
        // --------------------------------------------------
        const item = result.Item;

        const response = {
            meta: item.meta?.S
                ? JSON.parse(item.meta.S)
                : null,

            commonData: item.commonData?.S
                ? JSON.parse(item.commonData.S)
                : null,

            data: item.data?.S
                ? JSON.parse(item.data.S)
                : [],

            version: "1.0.0",
        };

        // --------------------------------------------------
        // RESPONSE
        // --------------------------------------------------
        return {
            ...globalHeaders(),
            statusCode: 200,
            body: JSON.stringify(response),
        };

    } catch (error) {
        console.error(
            "Error getting hotel cancellation policy:",
            error.response?.data ||
                error.message,
            error.stack
        );

        return await InternalError(error);
    }
};