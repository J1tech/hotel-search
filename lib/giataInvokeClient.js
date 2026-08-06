import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";

const client = new LambdaClient({
    region: process.env.REGION || process.env.region || "eu-west-1",
});

export async function invokeGiataEnrich(payload) {
    const arn = process.env.GIATA_ENRICH_FUNCTION_ARN;
    if (!arn) throw new Error("GIATA_ENRICH_FUNCTION_ARN not configured");

    const out = await client.send(new InvokeCommand({
        FunctionName: arn,
        InvocationType: "RequestResponse",
        Payload: JSON.stringify(payload),
    }));

    if (out.FunctionError) {
        const errPayload = new TextDecoder().decode(out.Payload);
        throw new Error(`GIATA invoke failed: ${errPayload}`);
    }

    const raw = new TextDecoder().decode(out.Payload);
    return JSON.parse(raw);
}
