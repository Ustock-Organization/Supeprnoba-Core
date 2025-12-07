/**
 * WebSocket Disconnect Handler
 * 
 * API Gateway WebSocket $disconnect 라우트 핸들러
 * 연결 정보를 DynamoDB에서 삭제
 */

const { DynamoDBClient, DeleteItemCommand } = require('@aws-sdk/client-dynamodb');

const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION || 'ap-northeast-2' });
const CONNECTIONS_TABLE = process.env.CONNECTIONS_TABLE || 'websocket-connections';

exports.handler = async (event) => {
    const connectionId = event.requestContext.connectionId;

    console.log(`WebSocket disconnected: ${connectionId}`);

    try {
        await dynamoClient.send(new DeleteItemCommand({
            TableName: CONNECTIONS_TABLE,
            Key: {
                connectionId: { S: connectionId }
            }
        }));

        return {
            statusCode: 200,
            body: 'Disconnected'
        };
    } catch (error) {
        console.error('Error removing connection:', error);
        return {
            statusCode: 500,
            body: 'Failed to disconnect'
        };
    }
};
