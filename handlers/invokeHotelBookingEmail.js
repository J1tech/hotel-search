import axios from "axios";
import { getSessionId, globalHeaders, InternalError } from "../helper/helper.js";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import {
    DynamoDBClient,
    QueryCommand,
    GetItemCommand,
    UpdateItemCommand
} from "@aws-sdk/client-dynamodb";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
const region = process.env.REGION
const dynamo = new DynamoDBClient({ region: region });
const sqsClient = new SQSClient({
    region: region,
});


export const handler = async (event, context) => {
    try {
        const requestId = context.awsRequestId
        console.log("AWS Request ID:", requestId);
        for (const record of event.Records) {
            console.log("JSON.parse(record.body)***********************", JSON.parse(record.body));



            let { hotelBookingData, userId, userType } = JSON.parse(record.body)
            hotelBookingData = JSON.parse(hotelBookingData);
            console.log("hotelBookingData*********", hotelBookingData);

            const getUserDetails = new QueryCommand({
                TableName: process.env.USERS_TABLE,
                KeyConditionExpression: "userId = :uid",
                ExpressionAttributeValues: {
                    ":uid": { S: userId },
                },
                Limit: 1,
            });

            const userData = await dynamo.send(getUserDetails);
            const userDetails = unmarshall(userData.Items[0]);

            console.log("userDetails******", userDetails);
            console.log("hotelBookingData?.data[0].hotel.hotelKey*********", hotelBookingData?.data[0].hotel.hotelKey);

            const passengers = hotelBookingData?.data[0].hotel.passengers

            const getHotelsDetails = new QueryCommand({
                TableName: process.env.LOG_TRACE_TABLE,
                IndexName: "GSI_Hotel_Step",
                KeyConditionExpression: "hotelKey  = :offerId AND stepCode = :stepCode",
                ExpressionAttributeValues: {
                    ":offerId": { S: hotelBookingData?.data[0].hotel.hotelKey, },
                    ":stepCode": { N: "120" }
                },
                Limit: 1
            });

            const getHotelDetailsData = await dynamo.send(getHotelsDetails);

            const item = getHotelDetailsData.Items[0];
            if (!item) {
                console.log("No items found for offerId", offerId);
                return;
            }

            // Unmarshall DynamoDB item
            const data = unmarshall(item);
            const response = typeof data?.response === "string"
                ? JSON.parse(data.response)
                : data?.response;

            console.log("data************", response);
            console.log("checker****", response?.data);
            console.log("data images************", response?.data?.[0]?.images);

            const checkInDate = new Date(hotelBookingData?.data[0].hotel?.checkInDate);
            const checkOutDate = new Date(hotelBookingData?.data[0].hotel?.checkOutDate);

            const diffTime = checkOutDate - checkInDate;
            const nights = diffTime / (1000 * 60 * 60 * 24);

            console.log("Number of nights:", nights)

            const mappedPassengers = passengers.map((passenger, index) => ({
                sNo: index + 1,
                passengerName: `${passenger?.passengerInfo?.nameTitle} ${passenger?.passengerInfo?.givenName} (${passenger?.ptc})`
            }));

            console.log(mappedPassengers);

            const emailData = {
                username: userDetails?.name,
                bookingReferenceId: hotelBookingData?.data[0].bookingReferenceId,
                email: userDetails?.email,
                hotelDetail: { hotelImages: response?.data?.[0]?.images, hotelName: hotelBookingData?.data[0].hotel?.name, checkIn: hotelBookingData?.data[0].hotel?.checkInDate, checkOut: hotelBookingData?.data[0].hotel?.checkOutDate, address: response?.data?.[0].address, totalNightStay: nights },
                purchaseSummary: { travellers: mappedPassengers }
                // flightDetails,
                // passengerNames: passengerNames,
                // passengersFares: passengersFares,
                // taxFees,
                // totalFare: fareDetails?.totalFare,
                // ticketImage: null
            }
            console.log(
                "emailData Details =======8888888888==============",
                JSON.stringify(emailData, null, 2)
            );

            // console.log("passengerNames************", passengerNames);

            // console.log(JSON.stringify(emailData, null, 2));
            // await sqsClient.send(new SendMessageCommand({
            //     QueueUrl: process.env.SEND_EMAIL_QUEUE,
            //     MessageBody: JSON.stringify(emailData)
            // }));
        }

        return {
            statusCode: 200,
            ...globalHeaders(),
            // body: JSON.stringify(response.data),
        };
    } catch (error) {
        console.log("error*********", error);

        return await InternalError(error)
    }
};

async function queryByIata(iataCode) {
    console.log("iataCode*********", iataCode);

    if (!iataCode) throw new Error("iataCode is undefined");

    const params = {
        TableName: process.env.COUNTRIES_LISTING_TABLE,
        IndexName: "GSI_IATA_CODE",
        KeyConditionExpression: "iataCode = :iata",
        ExpressionAttributeValues: {
            ":iata": { S: iataCode },
        },
    };

    const result = await dynamo.send(new QueryCommand(params));
    return result.Items[0].city.S;
}