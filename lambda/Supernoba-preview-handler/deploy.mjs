
import { LambdaClient, CreateFunctionCommand, DeleteFunctionCommand, GetFunctionCommand } from '@aws-sdk/client-lambda';
import { readFileSync } from 'fs';
import { join } from 'path';

const lambda = new LambdaClient({ region: 'ap-northeast-2' });
const FUNCTION_NAME = 'Supernoba-preview-handler';
// Use the Admin Role ARN directly
const ROLE_ARN = 'arn:aws:iam::264520158196:role/Supernoba-lambda-role';

async function deploy() {
    console.log(`Deploying ${FUNCTION_NAME} ...`);

    // 1. Delete Existing Function (To avoid 409 Conflicts and ensure fresh env)
    try {
        await lambda.send(new DeleteFunctionCommand({ FunctionName: FUNCTION_NAME }));
        console.log('✅ Deleted old function.');
    } catch (e) { 
        console.log('Delete skipped (function not found).'); 
    }

    // 2. Read Zip (Created by zip.mjs)
    const zipPath = join(process.cwd(), 'function_v2.zip');
    const zipBuffer = readFileSync(zipPath);

    // 3. Define Env Vars (Hardcoded for stability)
    // Note: Ideally fetching from Admin is better, but it caused issues.
    const safeEnv = {
        YOUTUBE_API_KEY: 'AIzaSyCJZO6pdChSbVVqcFfSNKJkvBZk4G051E0',
        TWITTER_BEARER_TOKEN: 'AAAAAAAAAAAAAAAAAAAAAHs65gEAAAAAsel6zJ3PLy/Kwg/RDgK9hrgcf0Q=PpvFj5olwMBiYVsukbcfwcghprHR6ygwD1rNDboAMGAh07fd6G'
    };

    // 4. Create Function
    console.log('Creating new function...');
    await lambda.send(new CreateFunctionCommand({
        FunctionName: FUNCTION_NAME,
        Runtime: 'nodejs20.x',
        Role: ROLE_ARN,
        Handler: 'handler.handler', // Renamed from index.mjs
        Code: { ZipFile: zipBuffer },
        Environment: { Variables: safeEnv },
        Timeout: 10,
        MemorySize: 128
    }));
    console.log('✅ Function created successfully!');
}

deploy().catch(console.error);
