import { APIGatewayClient, GetResourcesCommand, CreateResourceCommand, PutMethodCommand, PutIntegrationCommand, CreateDeploymentCommand } from "@aws-sdk/client-api-gateway";
import { LambdaClient, AddPermissionCommand } from "@aws-sdk/client-lambda";

const api = new APIGatewayClient({ region: 'ap-northeast-2' });
const lambda = new LambdaClient({ region: 'ap-northeast-2' });

const TARGET_API_ID = '4xs6g4w8l6'; 
const LAMBDA_NAME = 'Supernoba-approval-handler';
const REGION = 'ap-northeast-2';
const ACCOUNT_ID = '264520158196'; 
const LAMBDA_ARN = `arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:${LAMBDA_NAME}`;

async function setupEndpoint(pathPart, method) {
    console.log(`Setting up /${pathPart} (${method})...`);
    
    // 1. Get Root Resource
    const resources = await api.send(new GetResourcesCommand({ restApiId: TARGET_API_ID }));
    const rootId = resources.items.find(r => r.path === '/').id;
    
    // 2. Create Resource
    let resourceId = resources.items.find(r => r.path === `/${pathPart}`)?.id;
    if (!resourceId) {
        console.log(`Creating /${pathPart} resource...`);
        const res = await api.send(new CreateResourceCommand({
            restApiId: TARGET_API_ID,
            parentId: rootId,
            pathPart: pathPart
        }));
        resourceId = res.id;
    }
    console.log(`${pathPart} Resource ID:`, resourceId);
    
    // 3. Put Method
    try {
        await api.send(new PutMethodCommand({
            restApiId: TARGET_API_ID,
            resourceId: resourceId,
            httpMethod: method,
            authorizationType: 'NONE'
        }));
    } catch (e) {
        console.log('Method setup skipped/failed:', e.message);
    }
    
    // 4. Put Integration
    const integrationUri = `arn:aws:apigateway:${REGION}:lambda:path/2015-03-31/functions/${LAMBDA_ARN}/invocations`;
    
    await api.send(new PutIntegrationCommand({
        restApiId: TARGET_API_ID,
        resourceId: resourceId,
        httpMethod: method,
        type: 'AWS_PROXY',
        integrationHttpMethod: 'POST',
        uri: integrationUri
    }));

    // 5. Add Lambda Permission
    try {
        await lambda.send(new AddPermissionCommand({
            FunctionName: LAMBDA_NAME,
            StatementId: `apigateway-${pathPart}-${Date.now()}`,
            Action: 'lambda:InvokeFunction',
            Principal: 'apigateway.amazonaws.com',
            SourceArn: `arn:aws:execute-api:${REGION}:${ACCOUNT_ID}:${TARGET_API_ID}/*/${method}/${pathPart}`
        }));
        console.log(`Lambda permission added for /${pathPart}.`);
    } catch (e) {
         console.log('Lambda permission skipped (conflict).');
    }
}

async function setup() {
    await setupEndpoint('approve', 'POST');
    await setupEndpoint('reject', 'POST');
    
    // Deploy API
    console.log('Deploying API to stage restV2...');
    await api.send(new CreateDeploymentCommand({
        restApiId: TARGET_API_ID,
        stageName: 'restV2'
    }));
    
    console.log('✅ Approval/Reject API Setup Complete!');
}

setup().catch(console.error);
