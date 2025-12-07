/**
 * WebSocket Connect Handler
 * 
 * API Gateway WebSocket $connect 라우트 핸들러
 * 연결 정보를 DynamoDB에 저장
 */

const { DynamoDBClient, PutItemCommand } = require('@aws-sdk/client-dynamodb');

const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION || 'ap-northeast-2' });
const CONNECTIONS_TABLE = process.env.CONNECTIONS_TABLE || 'websocket-connections';

exports.handler = async (event) => {
    const connectionId = event.requestContext.connectionId;
    const connectTime = Date.now();

    console.log(`New WebSocket connection: ${connectionId}`);

    try {
        await dynamoClient.send(new PutItemCommand({
            TableName: CONNECTIONS_TABLE,
            Item: {
                connectionId: { S: connectionId },
                connectedAt: { N: connectTime.toString() },
                subscribedSymbols: { SS: ['*'] }  // 기본: 모든 심볼 구독
            }
        }));

        return {
            statusCode: 200,
            body: 'Connected'
        };
    } catch (error) {
        console.error('Error saving connection:', error);
        return {
            statusCode: 500,
            body: 'Failed to connect'
        };
    }
};
