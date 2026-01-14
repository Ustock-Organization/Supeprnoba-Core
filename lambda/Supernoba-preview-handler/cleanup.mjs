import { LambdaClient, DeleteFunctionCommand } from '@aws-sdk/client-lambda';
const lambda = new LambdaClient({ region: 'ap-northeast-2' });

async function cleanup() {
    try {
        console.log('Deleting Supernoba-preview-handler...');
        await lambda.send(new DeleteFunctionCommand({ FunctionName: 'Supernoba-preview-handler' }));
        console.log('✅ Function Deleted');
    } catch (e) {
        console.log('Delete failed (might not exist):', e.message);
    }
}
cleanup();
