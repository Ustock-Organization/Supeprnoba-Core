/**
 * Supernoba-ec2-mgmt
 * EC2 인스턴스 관리 전용 Lambda
 *
 * Endpoints:
 * - GET /ec2/instances - 인스턴스 목록
 * - GET /ec2/instances/{id} - 인스턴스 상세 + 메트릭
 * - POST /ec2/instances/{id}/start - 시작
 * - POST /ec2/instances/{id}/stop - 중지
 * - POST /ec2/instances/{id}/reboot - 재부팅
 * - GET /ec2/audit - 감사 로그
 */

import { EC2Client, DescribeInstancesCommand, StartInstancesCommand, StopInstancesCommand, RebootInstancesCommand } from '@aws-sdk/client-ec2';
import { CloudWatchClient, GetMetricStatisticsCommand } from '@aws-sdk/client-cloudwatch';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { verifyAdmin as verifyAdminJwt, authErrorResponse } from '/opt/nodejs/verifyAuth.mjs';

const REGION = 'ap-northeast-2';
const AUDIT_TABLE = 'supernoba-ec2-audit';

// Allowed instance tag filter (only manage instances with this tag)
const MANAGED_TAG_KEY = 'Project';
const MANAGED_TAG_VALUE = 'Supernoba';

// AWS Clients
const ec2Client = new EC2Client({ region: REGION });
const cwClient = new CloudWatchClient({ region: REGION });
const ddbClient = new DynamoDBClient({ region: REGION });
const docClient = DynamoDBDocumentClient.from(ddbClient);

// CORS Headers
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json'
};

// Response helpers
const jsonResponse = (statusCode, body) => ({
  statusCode,
  headers: CORS_HEADERS,
  body: JSON.stringify(body)
});

const errorResponse = (statusCode, message) => jsonResponse(statusCode, { error: message });

// Audit logging
const logAudit = async (userId, action, instanceId, result) => {
  try {
    const timestamp = new Date().toISOString();
    await docClient.send(new PutCommand({
      TableName: AUDIT_TABLE,
      Item: {
        pk: `AUDIT#${timestamp.slice(0, 10)}`,
        sk: `${timestamp}#${instanceId}`,
        userId,
        action,
        instanceId,
        result,
        timestamp
      }
    }));
  } catch (e) {
    console.error('[Audit] Failed to log:', e.message);
  }
};

// Get managed instances (filtered by tag)
const getManagedInstances = async () => {
  const command = new DescribeInstancesCommand({
    Filters: [
      {
        Name: `tag:${MANAGED_TAG_KEY}`,
        Values: [MANAGED_TAG_VALUE]
      }
    ]
  });

  const response = await ec2Client.send(command);
  const instances = [];

  for (const reservation of response.Reservations || []) {
    for (const instance of reservation.Instances || []) {
      const nameTag = instance.Tags?.find(t => t.Key === 'Name');
      instances.push({
        instanceId: instance.InstanceId,
        name: nameTag?.Value || instance.InstanceId,
        state: instance.State?.Name,
        instanceType: instance.InstanceType,
        publicIp: instance.PublicIpAddress || null,
        privateIp: instance.PrivateIpAddress || null,
        launchTime: instance.LaunchTime,
        availabilityZone: instance.Placement?.AvailabilityZone,
        tags: instance.Tags?.reduce((acc, t) => ({ ...acc, [t.Key]: t.Value }), {}) || {}
      });
    }
  }

  return instances;
};

// Get instance by ID (with validation)
const getInstanceById = async (instanceId) => {
  const instances = await getManagedInstances();
  return instances.find(i => i.instanceId === instanceId);
};

// Get CloudWatch metrics for instance
const getInstanceMetrics = async (instanceId) => {
  const now = new Date();
  const startTime = new Date(now.getTime() - 60 * 60 * 1000); // 1 hour ago

  const getMetric = async (metricName, namespace = 'AWS/EC2', dimensions = null) => {
    try {
      const command = new GetMetricStatisticsCommand({
        Namespace: namespace,
        MetricName: metricName,
        Dimensions: dimensions || [{ Name: 'InstanceId', Value: instanceId }],
        StartTime: startTime,
        EndTime: now,
        Period: 300, // 5 minutes
        Statistics: ['Average', 'Maximum']
      });
      const response = await cwClient.send(command);
      const datapoints = response.Datapoints || [];
      if (datapoints.length === 0) return null;

      // Sort by timestamp and get latest
      datapoints.sort((a, b) => new Date(b.Timestamp) - new Date(a.Timestamp));
      return {
        average: datapoints[0].Average,
        maximum: datapoints[0].Maximum,
        timestamp: datapoints[0].Timestamp
      };
    } catch (e) {
      console.error(`[Metrics] ${metricName} error:`, e.message);
      return null;
    }
  };

  // Memory metric from CloudWatch Agent (CWAgent namespace)
  const getMemoryMetric = async () => {
    // Try different dimension combinations that CloudWatch Agent might use
    const dimensionCombinations = [
      [{ Name: 'InstanceId', Value: instanceId }],
      [
        { Name: 'InstanceId', Value: instanceId },
        { Name: 'ImageId', Value: '*' },
        { Name: 'InstanceType', Value: '*' }
      ]
    ];

    for (const dims of dimensionCombinations) {
      const result = await getMetric('mem_used_percent', 'CWAgent', dims);
      if (result) return result;
    }
    return null;
  };

  const [cpu, networkIn, networkOut, memory] = await Promise.all([
    getMetric('CPUUtilization'),
    getMetric('NetworkIn'),
    getMetric('NetworkOut'),
    getMemoryMetric()
  ]);

  return { cpu, networkIn, networkOut, memory };
};

// Handlers
const handleListInstances = async () => {
  try {
    const instances = await getManagedInstances();
    return jsonResponse(200, { instances, count: instances.length });
  } catch (e) {
    console.error('[ListInstances] Error:', e);
    return errorResponse(500, e.message);
  }
};

const handleGetInstance = async (instanceId) => {
  try {
    const instance = await getInstanceById(instanceId);
    if (!instance) {
      return errorResponse(404, 'Instance not found or not managed');
    }

    const metrics = await getInstanceMetrics(instanceId);
    return jsonResponse(200, { instance, metrics });
  } catch (e) {
    console.error('[GetInstance] Error:', e);
    return errorResponse(500, e.message);
  }
};

const handleStartInstance = async (instanceId, userId) => {
  try {
    // Verify instance is managed
    const instance = await getInstanceById(instanceId);
    if (!instance) {
      return errorResponse(404, 'Instance not found or not managed');
    }

    if (instance.state === 'running') {
      return errorResponse(400, 'Instance is already running');
    }

    const command = new StartInstancesCommand({ InstanceIds: [instanceId] });
    await ec2Client.send(command);

    await logAudit(userId, 'START', instanceId, 'initiated');

    return jsonResponse(200, {
      success: true,
      message: `Instance ${instanceId} start initiated`,
      previousState: instance.state
    });
  } catch (e) {
    console.error('[StartInstance] Error:', e);
    await logAudit(userId, 'START', instanceId, `error: ${e.message}`);
    return errorResponse(500, e.message);
  }
};

const handleStopInstance = async (instanceId, userId) => {
  try {
    const instance = await getInstanceById(instanceId);
    if (!instance) {
      return errorResponse(404, 'Instance not found or not managed');
    }

    if (instance.state === 'stopped') {
      return errorResponse(400, 'Instance is already stopped');
    }

    const command = new StopInstancesCommand({ InstanceIds: [instanceId] });
    await ec2Client.send(command);

    await logAudit(userId, 'STOP', instanceId, 'initiated');

    return jsonResponse(200, {
      success: true,
      message: `Instance ${instanceId} stop initiated`,
      previousState: instance.state
    });
  } catch (e) {
    console.error('[StopInstance] Error:', e);
    await logAudit(userId, 'STOP', instanceId, `error: ${e.message}`);
    return errorResponse(500, e.message);
  }
};

const handleRebootInstance = async (instanceId, userId) => {
  try {
    const instance = await getInstanceById(instanceId);
    if (!instance) {
      return errorResponse(404, 'Instance not found or not managed');
    }

    if (instance.state !== 'running') {
      return errorResponse(400, 'Instance must be running to reboot');
    }

    const command = new RebootInstancesCommand({ InstanceIds: [instanceId] });
    await ec2Client.send(command);

    await logAudit(userId, 'REBOOT', instanceId, 'initiated');

    return jsonResponse(200, {
      success: true,
      message: `Instance ${instanceId} reboot initiated`
    });
  } catch (e) {
    console.error('[RebootInstance] Error:', e);
    await logAudit(userId, 'REBOOT', instanceId, `error: ${e.message}`);
    return errorResponse(500, e.message);
  }
};

const handleGetAuditLogs = async (date) => {
  try {
    const targetDate = date || new Date().toISOString().slice(0, 10);

    const command = new QueryCommand({
      TableName: AUDIT_TABLE,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: {
        ':pk': `AUDIT#${targetDate}`
      },
      ScanIndexForward: false,
      Limit: 100
    });

    const response = await docClient.send(command);
    return jsonResponse(200, { logs: response.Items || [], count: response.Count });
  } catch (e) {
    console.error('[GetAuditLogs] Error:', e);
    return errorResponse(500, e.message);
  }
};

// Main handler
export const handler = async (event) => {
  console.log('[EC2-Mgmt] Event:', JSON.stringify({
    method: event.httpMethod,
    path: event.path,
    resource: event.resource
  }));

  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return jsonResponse(200, { message: 'OK' });
  }

  // Auth check — Cognito JWT + is_admin (4자리 공유키 폐기)
  const adminCheck = await verifyAdminJwt(event);
  if (!adminCheck.success) {
    return authErrorResponse(adminCheck, CORS_HEADERS);
  }

  const method = event.httpMethod;
  const path = event.path || '';
  const queryParams = event.queryStringParameters || {};

  // Parse instanceId from path: /ec2/instances/i-xxxxx or /ec2/instances/i-xxxxx/action
  const instanceIdMatch = path.match(/\/ec2\/instances\/(i-[a-z0-9]+)/);
  const instanceId = instanceIdMatch ? instanceIdMatch[1] : null;

  // 감사 로그용 행위자 — 토큰에서 유도한 관리자 신원(요청 파라미터 대신)
  const userId = adminCheck.userId || 'admin';

  // Route handling
  try {
    // GET /ec2/instances
    if (method === 'GET' && path.match(/\/ec2\/instances\/?$/)) {
      return await handleListInstances();
    }

    // GET /ec2/instances/{id}
    if (method === 'GET' && instanceId && !path.includes('/audit')) {
      return await handleGetInstance(instanceId);
    }

    // POST /ec2/instances/{id}/start
    if (method === 'POST' && path.includes('/start') && instanceId) {
      return await handleStartInstance(instanceId, userId);
    }

    // POST /ec2/instances/{id}/stop
    if (method === 'POST' && path.includes('/stop') && instanceId) {
      return await handleStopInstance(instanceId, userId);
    }

    // POST /ec2/instances/{id}/reboot
    if (method === 'POST' && path.includes('/reboot') && instanceId) {
      return await handleRebootInstance(instanceId, userId);
    }

    // GET /ec2/audit
    if (method === 'GET' && path.includes('/audit')) {
      return await handleGetAuditLogs(queryParams.date);
    }

    return errorResponse(404, 'Not found');
  } catch (e) {
    console.error('[EC2-Mgmt] Unhandled error:', e);
    return errorResponse(500, 'Internal server error');
  }
};
