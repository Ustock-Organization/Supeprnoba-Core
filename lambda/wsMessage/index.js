/**
 * WebSocket Subscribe Handler
 * 
 * API Gateway WebSocket $default 라우트 핸들러
 * 클라이언트가 특정 심볼 구독/해제 요청 처리
 * 
 * 메시지 형식:
 * { "action": "subscribe", "symbol": "AAPL" }
 * { "action": "unsubscribe", "symbol": "AAPL" }
 */

const { DynamoDBClient, UpdateItemCommand } = require('@aws-sdk/client-dynamodb');
const { ApiGatewayManagementApiClient, PostToConnectionCommand } = require('@aws-sdk/client-apigatewaymanagementapi');

const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION || 'ap-northeast-2' });
const CONNECTIONS_TABLE = process.env.CONNECTIONS_TABLE || 'websocket-connections';

exports.handler = async (event) => {
    const connectionId = event.requestContext.connectionId;
    const domainName = event.requestContext.domainName;
    const stage = event.requestContext.stage;

    let body;
    try {
        body = JSON.parse(event.body);
    } catch (e) {
        return { statusCode: 400, body: 'Invalid JSON' };
    }

    const { action, symbol } = body;

    if (!action || !symbol) {
        return { statusCode: 400, body: 'Missing action or symbol' };
    }

    console.log(`Connection ${connectionId}: ${action} ${symbol}`);

    try {
        if (action === 'subscribe') {
            await dynamoClient.send(new UpdateItemCommand({
                TableName: CONNECTIONS_TABLE,
                Key: { connectionId: { S: connectionId } },
                UpdateExpression: 'ADD subscribedSymbols :symbol',
                ExpressionAttributeValues: {
                    ':symbol': { SS: [symbol] }
                }
            }));
        } else if (action === 'unsubscribe') {
            await dynamoClient.send(new UpdateItemCommand({
                TableName: CONNECTIONS_TABLE,
                Key: { connectionId: { S: connectionId } },
                UpdateExpression: 'DELETE subscribedSymbols :symbol',
                ExpressionAttributeValues: {
                    ':symbol': { SS: [symbol] }
                }
            }));
        }

        // 확인 메시지 전송
        const apiGateway = new ApiGatewayManagementApiClient({
            endpoint: `https://${domainName}/${stage}`,
            region: process.env.AWS_REGION || 'ap-northeast-2'
        });

        await apiGateway.send(new PostToConnectionCommand({
            ConnectionId: connectionId,
            Data: JSON.stringify({
                type: 'SUBSCRIPTION',
                action: action,
                symbol: symbol,
                success: true
            })
        }));

        return { statusCode: 200, body: 'OK' };
    } catch (error) {
        console.error('Error handling subscription:', error);
        return { statusCode: 500, body: 'Error' };
    }
};
