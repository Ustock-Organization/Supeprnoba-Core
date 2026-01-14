import { LambdaClient, CreateFunctionCommand, UpdateFunctionCodeCommand, UpdateFunctionConfigurationCommand, GetFunctionCommand } from "@aws-sdk/client-lambda";
import { readFileSync } from 'fs';

const lambda = new LambdaClient({ region: 'ap-northeast-2' });
const FUNCTION_NAME = 'Supernoba-approval-handler';

async function deploy() {
    const zipPath = './function.zip';
    const zipBuffer = readFileSync(zipPath);
    console.log(`Deploying ${FUNCTION_NAME} (${zipBuffer.length} bytes)...`);

    let roleArn;

    try {
        // 1. Get Environment Variables & Role from Supernoba-admin
        console.log('Fetching config from Supernoba-admin...');
        const adminFunc = await lambda.send(new GetFunctionCommand({ FunctionName: 'Supernoba-admin' }));
        const currentEnv = adminFunc.Configuration?.Environment?.Variables || {};
        roleArn = adminFunc.Configuration?.Role;
        
        console.log('Using Role:', roleArn);

        // Inherit all env vars (DB, Redis, Supabase keys etc)
        const safeEnv = { ...currentEnv };
        
        console.log('Env Vars count:', Object.keys(safeEnv).length);

        // 2. Try Updating
        console.log('Updating Code...');
        await lambda.send(new UpdateFunctionCodeCommand({
            FunctionName: FUNCTION_NAME,
            ZipFile: zipBuffer
        }));

        console.log('Updating Configuration...');
        await lambda.send(new UpdateFunctionConfigurationCommand({
            FunctionName: FUNCTION_NAME,
            Environment: { Variables: safeEnv },
            Role: roleArn,
            Handler: 'index.handler',
            Runtime: 'nodejs20.x'
        }));
        
        console.log('✅ Function code updated!');

    } catch (e) {
        if (e.name === 'ResourceNotFoundException') {
            console.log('Function not found. Creating new function...');
            const adminFunc = await lambda.send(new GetFunctionCommand({ FunctionName: 'Supernoba-admin' }));
            const envWithKeys = adminFunc.Configuration?.Environment?.Variables || {};
            
            await lambda.send(new CreateFunctionCommand({
                FunctionName: FUNCTION_NAME,
                Runtime: 'nodejs20.x',
                Role: roleArn, // Use strict role from admin
                Handler: 'index.handler',
                Code: { ZipFile: zipBuffer },
                Environment: { Variables: envWithKeys },
                Timeout: 60,
                MemorySize: 256
            }));
            console.log('✅ Function created!');
        } else {
            console.error(e);
        }
    }
}

deploy();
