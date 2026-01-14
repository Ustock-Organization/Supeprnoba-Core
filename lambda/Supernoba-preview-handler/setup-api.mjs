import { APIGatewayClient, GetResourcesCommand, CreateResourceCommand, PutMethodCommand, PutIntegrationCommand, CreateDeploymentCommand, PutMethodResponseCommand, PutIntegrationResponseCommand } from "@aws-sdk/client-api-gateway";
import { LambdaClient, AddPermissionCommand } from "@aws-sdk/client-lambda";

const api = new APIGatewayClient({ region: 'ap-northeast-2' });
const lambda = new LambdaClient({ region: 'ap-northeast-2' });

const TARGET_API_ID = '4xs6g4w8l6'; // From Add.js logic
const LAMBDA_NAME = 'Supernoba-preview-handler';
const REGION = 'ap-northeast-2';
// Account ID retrieval logic or hardcoded
const ACCOUNT_ID = '264520158196'; 
const LAMBDA_ARN = `arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:${LAMBDA_NAME}`;

async function setup() {
    console.log(`Setting up API Gateway for ${TARGET_API_ID}...`);
    
    // 1. Get Root Resource
    const resources = await api.send(new GetResourcesCommand({ restApiId: TARGET_API_ID }));
    const rootId = resources.items.find(r => r.path === '/').id;
    console.log('Root Resource ID:', rootId);
    
    // 2. Create /preview Resource
    let previewId = resources.items.find(r => r.path === '/preview')?.id;
    if (!previewId) {
        console.log('Creating /preview resource...');
        const res = await api.send(new CreateResourceCommand({
            restApiId: TARGET_API_ID,
            parentId: rootId,
            pathPart: 'preview'
        }));
        previewId = res.id;
    }
    console.log('Preview Resource ID:', previewId);
    
    // 3. Put Method GET
    console.log('Setting up GET method...');
    try {
        await api.send(new PutMethodCommand({
            restApiId: TARGET_API_ID,
            resourceId: previewId,
            httpMethod: 'GET',
            authorizationType: 'NONE'
        }));
    } catch (e) {
        console.log('GET Method setup skipped/failed:', e.message);
    }
    
    // 4. Put Integration (AWS_PROXY)
    const integrationUri = `arn:aws:apigateway:${REGION}:lambda:path/2015-03-31/functions/${LAMBDA_ARN}/invocations`;
    
    await api.send(new PutIntegrationCommand({
        restApiId: TARGET_API_ID,
        resourceId: previewId,
        httpMethod: 'GET',
        type: 'AWS_PROXY',
        integrationHttpMethod: 'POST',
        uri: integrationUri
    }));

    // 4-1. Create OPTIONS Method (CORS)
    try {
        await api.send(new PutMethodCommand({
            restApiId: TARGET_API_ID,
            resourceId: previewId,
            httpMethod: 'OPTIONS',
            authorizationType: 'NONE'
        }));
         await api.send(new PutIntegrationCommand({
            restApiId: TARGET_API_ID,
            resourceId: previewId,
            httpMethod: 'OPTIONS',
            type: 'MOCK',
            requestTemplates: { "application/json": "{\"statusCode\": 200}" }
        }));
        await api.send(new PutMethodResponseCommand({
            restApiId: TARGET_API_ID,
            resourceId: previewId,
            httpMethod: 'OPTIONS',
            statusCode: '200',
            responseParameters: {
                'method.response.header.Access-Control-Allow-Headers': true,
                'method.response.header.Access-Control-Allow-Methods': true,
                'method.response.header.Access-Control-Allow-Origin': true
            }
        }));
         await api.send(new PutIntegrationResponseCommand({
            restApiId: TARGET_API_ID,
            resourceId: previewId,
            httpMethod: 'OPTIONS',
            statusCode: '200',
            responseParameters: {
                'method.response.header.Access-Control-Allow-Headers': "'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token'",
                'method.response.header.Access-Control-Allow-Methods': "'GET,OPTIONS'",
                'method.response.header.Access-Control-Allow-Origin': "'*'"
            }
        }));
        console.log('OPTIONS Method (CORS) setup complete.');
    } catch (e) {
        console.log('OPTIONS setup skipped/failed:', e.message);
    }

    // 5. Add Lambda Permission
    try {
        await lambda.send(new AddPermissionCommand({
            FunctionName: LAMBDA_NAME,
            StatementId: `apigateway-preview-${Date.now()}`,
            Action: 'lambda:InvokeFunction',
            Principal: 'apigateway.amazonaws.com',
            SourceArn: `arn:aws:execute-api:${REGION}:${ACCOUNT_ID}:${TARGET_API_ID}/*/GET/preview`
        }));
        console.log('Lambda permission added.');
    } catch (e) {
        if (e.name === 'ResourceConflictException') {
            console.log('Lambda permission already exists (or conflict).');
        } else {
            console.warn('Permission warning:', e.message);
        }
    }
    
    // 6. Deploy API
    console.log('Deploying API to stage restV2...');
    await api.send(new CreateDeploymentCommand({
        restApiId: TARGET_API_ID,
        stageName: 'restV2'
    }));
    
    console.log('✅ API Setup Complete! Endpoint:');
    console.log(`https://${TARGET_API_ID}.execute-api.${REGION}.amazonaws.com/restV2/preview?url=...`);
}

setup().catch(console.error);
