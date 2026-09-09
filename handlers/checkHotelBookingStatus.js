import { globalHeaders, InternalError } from "../helper/helper.js";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  markReconcileComplete,
  shouldRunReconcile,
} from "../helper/hotelPendingPoll.js";
import {
  reconcilePendingHotelPolls,
  runHotelPendingPollCycle,
} from "../helper/hotelBookingStatusSync.js";

const dynamo = new DynamoDBClient({ region: process.env.REGION });

export const handler = async (event, context) => {
  try {
    const requestId = context?.awsRequestId || `req-${Date.now()}`;
    const forceReconcile =
      event?.reconcile === true ||
      event?.detail?.reconcile === true;

    let reconciled = 0;
    if (forceReconcile || (await shouldRunReconcile())) {
      reconciled = await reconcilePendingHotelPolls(dynamo);
      await markReconcileComplete();
      console.log("Reconciled pending hotel polls:", reconciled);
    }

    const summary = await runHotelPendingPollCycle({ dynamo, requestId });
    const body = {
      reconciled,
      ...summary,
    };

    console.log("Hotel pending poll cycle summary:", JSON.stringify(body));

    if (event?.httpMethod || event?.requestContext) {
      return {
        statusCode: 200,
        ...globalHeaders(),
        body: JSON.stringify(body),
      };
    }

    return body;
  } catch (error) {
    console.error(
      "Error in checkHotelBookingStatus:",
      error?.response?.data || error?.message,
      error?.stack
    );
    return await InternalError(error);
  }
};
