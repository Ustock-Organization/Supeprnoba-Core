/**
 * Supernoba Shared Logger Module
 * Provides structured JSON logging for CloudWatch
 */

// Error codes for standardized responses
export const ErrorCodes = {
  // Validation errors (4xx)
  VALIDATION_ERROR: { code: 'VALIDATION_ERROR', status: 400 },
  INVALID_REQUEST: { code: 'INVALID_REQUEST', status: 400 },
  INVALID_SYMBOL: { code: 'INVALID_SYMBOL', status: 400 },
  MISSING_FIELDS: { code: 'MISSING_FIELDS', status: 400 },
  INVALID_JSON: { code: 'INVALID_JSON', status: 400 },

  // Auth errors (401/403)
  UNAUTHORIZED: { code: 'UNAUTHORIZED', status: 401 },
  INVALID_TOKEN: { code: 'INVALID_TOKEN', status: 401 },
  USER_SUSPENDED: { code: 'USER_SUSPENDED', status: 403 },
  FORBIDDEN: { code: 'FORBIDDEN', status: 403 },

  // Business logic errors (400)
  INSUFFICIENT_FUNDS: { code: 'INSUFFICIENT_FUNDS', status: 400 },
  ORDER_NOT_FOUND: { code: 'ORDER_NOT_FOUND', status: 404 },
  SYMBOL_INACTIVE: { code: 'SYMBOL_INACTIVE', status: 400 },
  CONCURRENCY_ERROR: { code: 'CONCURRENCY_ERROR', status: 409 },

  // System errors (5xx)
  INTERNAL_ERROR: { code: 'INTERNAL_ERROR', status: 500 },
  DATABASE_ERROR: { code: 'DATABASE_ERROR', status: 500 },
  KINESIS_ERROR: { code: 'KINESIS_ERROR', status: 500 },
  VALKEY_ERROR: { code: 'VALKEY_ERROR', status: 500 },
  TIMEOUT_ERROR: { code: 'TIMEOUT_ERROR', status: 504 },

  // Maintenance (503)
  MAINTENANCE_MODE: { code: 'MAINTENANCE_MODE', status: 503 },
  TRADING_DISABLED: { code: 'TRADING_DISABLED', status: 503 },
};

/**
 * Logger class for structured logging
 */
export class Logger {
  constructor(functionName, requestId = null) {
    this.functionName = functionName;
    this.requestId = requestId;
  }

  _formatLog(level, message, data = {}) {
    return JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      function: this.functionName,
      requestId: this.requestId,
      message,
      ...data,
    });
  }

  info(message, data = {}) {
    console.log(this._formatLog('INFO', message, data));
  }

  warn(message, data = {}) {
    console.warn(this._formatLog('WARN', message, data));
  }

  error(message, error = null, data = {}) {
    const errorData = error ? {
      errorName: error.name,
      errorMessage: error.message,
      errorStack: error.stack?.split('\n').slice(0, 5).join('\n'),
    } : {};
    console.error(this._formatLog('ERROR', message, { ...errorData, ...data }));
  }

  debug(message, data = {}) {
    if (process.env.DEBUG === 'true') {
      console.log(this._formatLog('DEBUG', message, data));
    }
  }
}

/**
 * Create a standardized error response
 */
export function createErrorResponse(errorCode, message = null, details = null, headers = null) {
  const { code, status } = typeof errorCode === 'string'
    ? (ErrorCodes[errorCode] || ErrorCodes.INTERNAL_ERROR)
    : errorCode;

  const response = {
    statusCode: status,
    headers: headers || {
      'Access-Control-Allow-Origin': '*',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      error: {
        code,
        message: message || code,
        ...(details && { details }),
      },
    }),
  };

  return response;
}

/**
 * Create a standardized success response
 */
export function createSuccessResponse(data, statusCode = 200, headers = null) {
  return {
    statusCode,
    headers: headers || {
      'Access-Control-Allow-Origin': '*',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(data),
  };
}

/**
 * Wrap a Lambda handler with error handling
 */
export function withErrorHandling(functionName, handler) {
  return async (event, context) => {
    const requestId = context?.awsRequestId || 'unknown';
    const logger = new Logger(functionName, requestId);

    try {
      logger.info('Handler invoked', {
        httpMethod: event.httpMethod,
        path: event.path,
        hasBody: !!event.body,
      });

      const result = await handler(event, context, logger);

      logger.info('Handler completed', {
        statusCode: result?.statusCode,
      });

      return result;
    } catch (error) {
      logger.error('Unhandled exception', error, {
        eventKeys: Object.keys(event || {}),
      });

      // Classify error
      if (error.name === 'ValidationError') {
        return createErrorResponse(ErrorCodes.VALIDATION_ERROR, error.message);
      }
      if (error.name === 'ConditionalCheckFailedException') {
        return createErrorResponse(ErrorCodes.CONCURRENCY_ERROR, 'Concurrent modification detected');
      }
      if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
        return createErrorResponse(ErrorCodes.TIMEOUT_ERROR, 'Service connection timeout');
      }

      return createErrorResponse(ErrorCodes.INTERNAL_ERROR, error.message);
    }
  };
}

/**
 * Parse request body safely
 */
export function parseBody(event) {
  if (!event.body) return {};
  try {
    return typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
  } catch (e) {
    throw Object.assign(new Error('Invalid JSON in request body'), { name: 'ValidationError' });
  }
}

/**
 * Validate required fields
 */
export function validateRequired(data, fields) {
  const missing = fields.filter(f => !data[f] && data[f] !== 0 && data[f] !== false);
  if (missing.length > 0) {
    throw Object.assign(
      new Error(`Missing required fields: ${missing.join(', ')}`),
      { name: 'ValidationError' }
    );
  }
}
