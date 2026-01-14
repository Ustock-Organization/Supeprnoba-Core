import { ApiGatewayV2Client, GetApisCommand } from "@aws-sdk/client-apigatewayv2";
import { APIGatewayClient, GetRestApisCommand } from "@aws-sdk/client-api-gateway";

const v2 = new ApiGatewayV2Client({ region: "ap-northeast-2" });
const v1 = new APIGatewayClient({ region: "ap-northeast-2" });

async function list() {
  console.log("--- HTTP APIs (v2) ---");
  try {
    const res = await v2.send(new GetApisCommand({}));
    res.Items.forEach(api => {
        console.log(`ID: ${api.ApiId}, Name: ${api.Name}, Endpoint: ${api.ApiEndpoint}`);
    });
  } catch (e) { console.error(e.message); }

  console.log("\n--- REST APIs (v1) ---");
  try {
    const res = await v1.send(new GetRestApisCommand({}));
    res.items.forEach(api => {
        console.log(`ID: ${api.id}, Name: ${api.name}`);
    });
  } catch (e) { console.error(e.message); }
}

list();
