/**
 * depthStreamHandler Lambda
 * 
 * MSK depth 토픽 구독 → WebSocket 연결된 모든 클라이언트에 호가 실시간 푸시
 * 비로그인 사용자도 호가 데이터를 받을 수 있음 (공개 데이터)
 * 
 * 트리거: Amazon MSK (depth 토픽)
 * 출력: API Gateway WebSocket → 클라이언트
 */

const { ApiGatewayManagementApiClient, PostToConnectionCommand } = require('@aws-sdk/client-apigatewaymanagementapi');
const { DynamoDBClient, ScanCommand, DeleteCommand } = require('@aws-sdk/client-dynamodb');

const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION || 'ap-northeast-2' });

// WebSocket 연결 테이블 이름
const CONNECTIONS_TABLE = process.env.CONNECTIONS_TABLE || 'websocket-connections';
const WEBSOCKET_ENDPOINT = process.env.WEBSOCKET_ENDPOINT; // e.g., "abc123.execute-api.ap-northeast-2.amazonaws.com/prod"

let apiGatewayClient = null;

function getApiGatewayClient() {
    if (!apiGatewayClient && WEBSOCKET_ENDPOINT) {
        apiGatewayClient = new ApiGatewayManagementApiClient({
            endpoint: `https://${WEBSOCKET_ENDPOINT}`,
            region: process.env.AWS_REGION || 'ap-northeast-2'
        });
    }
    return apiGatewayClient;
}

/**
 * DynamoDB에서 특정 심볼을 구독한 모든 연결 조회
 * 또는 모든 활성 연결 조회 (심볼 필터 없을 경우)
 */
async function getConnections(symbol = null) {
    try {
        const params = {
            TableName: CONNECTIONS_TABLE
        };

        // 심볼 필터가 있으면 추가
        if (symbol) {
            params.FilterExpression = 'contains(subscribedSymbols, :symbol) OR attribute_not_exists(subscribedSymbols)';
            params.ExpressionAttributeValues = {
                ':symbol': { S: symbol }
            };
        }

        const result = await dynamoClient.send(new ScanCommand(params));
        return result.Items || [];
    } catch (error) {
        console.error('Error fetching connections:', error);
        return [];
    }
}

/**
 * 연결 제거 (stale connection)
 */
async function removeConnection(connectionId) {
    try {
        await dynamoClient.send(new DeleteCommand({
            TableName: CONNECTIONS_TABLE,
            Key: { connectionId: { S: connectionId } }
        }));
        console.log(`Removed stale connection: ${connectionId}`);
    } catch (error) {
        console.error(`Error removing connection ${connectionId}:`, error);
    }
}

/**
 * 단일 연결에 메시지 전송
 */
async function sendToConnection(connectionId, data) {
    const client = getApiGatewayClient();
    if (!client) {
        console.error('API Gateway client not configured');
        return false;
    }

    try {
        await client.send(new PostToConnectionCommand({
            ConnectionId: connectionId,
            Data: JSON.stringify(data)
        }));
        return true;
    } catch (error) {
        if (error.statusCode === 410 || error.$metadata?.httpStatusCode === 410) {
            // Gone - 연결이 끊어짐
            console.log(`Connection ${connectionId} is gone, removing...`);
            await removeConnection(connectionId);
        } else {
            console.error(`Error sending to ${connectionId}:`, error);
        }
        return false;
    }
}

/**
 * MSK 레코드에서 depth 메시지 파싱
 */
function parseDepthMessage(record) {
    try {
        // MSK 레코드 value는 base64 인코딩됨
        const value = Buffer.from(record.value, 'base64').toString('utf8');
        return JSON.parse(value);
    } catch (error) {
        console.error('Error parsing depth message:', error);
        return null;
    }
}

/**
 * Lambda 핸들러 - MSK 트리거
 */
exports.handler = async (event) => {
    console.log('Received MSK event with', Object.keys(event.records).length, 'topics');
    
    // 각 토픽의 레코드 처리
    for (const [topic, partitions] of Object.entries(event.records)) {
        for (const record of partitions) {
            const depthData = parseDepthMessage(record);
            if (!depthData) continue;

            const symbol = depthData.symbol;
            if (!symbol) {
                console.warn('Depth message missing symbol:', depthData);
                continue;
            }

            console.log(`Broadcasting depth for ${symbol}: ${depthData.bids?.length || 0} bids, ${depthData.asks?.length || 0} asks`);

            // 해당 심볼 구독자 + 전체 구독자 조회
            const connections = await getConnections(symbol);
            console.log(`Found ${connections.length} connections for ${symbol}`);

            // 모든 연결에 전송
            const sendPromises = connections.map(conn => {
                const connectionId = conn.connectionId?.S;
                if (!connectionId) return Promise.resolve();

                return sendToConnection(connectionId, {
                    type: 'DEPTH',
                    symbol: symbol,
                    data: depthData,
                    timestamp: Date.now()
                });
            });

            await Promise.allSettled(sendPromises);
        }
    }

    return {
        statusCode: 200,
        body: 'Processed'
    };
};
