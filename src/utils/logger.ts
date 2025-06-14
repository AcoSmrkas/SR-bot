import winston from 'winston';
import path from 'path';
import fs from 'fs';
import { LogLevel, LogContext } from '../types';

// Ensure log directory exists
function ensureLogDirectory(logDir: string): void {
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
}

// Custom format for structured logging
const customFormat = winston.format.combine(
  winston.format.timestamp({
    format: 'YYYY-MM-DD HH:mm:ss.SSS'
  }),
  winston.format.errors({ stack: true }),
  winston.format.json(),
  winston.format.printf(({ timestamp, level, message, component, operation, boxId, txId, height, duration, error, ...meta }) => {
    const logEntry: any = {
      timestamp,
      level,
      message,
      component,
    };

    if (operation) logEntry.operation = operation;
    if (boxId) logEntry.boxId = boxId;
    if (txId) logEntry.txId = txId;
    if (height !== undefined) logEntry.height = height;
    if (duration !== undefined) logEntry.duration = duration;
    if (error && typeof error === 'object' && error !== null) {
      logEntry.error = {
        message: (error as any).message || 'Unknown error',
        stack: (error as any).stack,
        name: (error as any).name || 'Error'
      };
    }

    // Add any additional metadata
    if (Object.keys(meta).length > 0) {
      logEntry.meta = meta;
    }

    return JSON.stringify(logEntry, (key, value) =>
      typeof value === 'bigint' ? value.toString() : value
    );
  })
);

// Console format for development
const consoleFormat = winston.format.combine(
  winston.format.timestamp({
    format: 'HH:mm:ss'
  }),
  winston.format.colorize(),
  winston.format.printf(({ timestamp, level, message, component, operation, boxId, txId, height, duration, error }) => {
    let logMessage = `${timestamp} [${level}] [${component}]`;
    
    if (operation) logMessage += ` ${operation}`;
    if (boxId && typeof boxId === 'string') logMessage += ` box:${boxId.substring(0, 8)}...`;
    if (txId && typeof txId === 'string') logMessage += ` tx:${txId.substring(0, 8)}...`;
    if (height !== undefined) logMessage += ` height:${height}`;
    if (duration !== undefined) logMessage += ` (${duration}ms)`;
    
    logMessage += `: ${message}`;
    
    if (error && typeof error === 'object' && error !== null) {
      logMessage += `\n  Error: ${(error as any).message || 'Unknown error'}`;
      if ((error as any).stack) {
        logMessage += `\n  Stack: ${(error as any).stack}`;
      }
    }
    
    return logMessage;
  })
);

class Logger {
  private winston: winston.Logger;
  private logDir: string;

  constructor(logLevel: LogLevel = 'info', logDir: string = './logs') {
    this.logDir = logDir;
    ensureLogDirectory(logDir);

    this.winston = winston.createLogger({
      level: logLevel,
      format: customFormat,
      transports: [
        // Console transport for development
        new winston.transports.Console({
          format: consoleFormat,
          level: process.env.NODE_ENV === 'development' ? 'debug' : logLevel
        }),

        // File transport for all logs
        new winston.transports.File({
          filename: path.join(logDir, 'sr-bot.log'),
          maxsize: 10 * 1024 * 1024, // 10MB
          maxFiles: 5,
          tailable: true
        }),

        // Separate file for errors
        new winston.transports.File({
          filename: path.join(logDir, 'error.log'),
          level: 'error',
          maxsize: 10 * 1024 * 1024, // 10MB
          maxFiles: 3,
          tailable: true
        }),

        // Separate file for transactions
        new winston.transports.File({
          filename: path.join(logDir, 'transactions.log'),
          format: winston.format.combine(
            winston.format.timestamp(),
            winston.format.json()
          ),
          maxsize: 50 * 1024 * 1024, // 50MB
          maxFiles: 10,
          tailable: true
        })
      ],

      // Handle uncaught exceptions and rejections
      exceptionHandlers: [
        new winston.transports.File({
          filename: path.join(logDir, 'exceptions.log')
        })
      ],
      rejectionHandlers: [
        new winston.transports.File({
          filename: path.join(logDir, 'rejections.log')
        })
      ]
    });
  }

  private log(level: LogLevel, message: string, context?: LogContext): void {
    this.winston.log(level, message, context);
  }

  debug(message: string, context?: LogContext): void {
    this.log('debug', message, context);
  }

  info(message: string, context?: LogContext): void {
    this.log('info', message, context);
  }

  warn(message: string, context?: LogContext): void {
    this.log('warn', message, context);
  }

  error(message: string, context?: LogContext): void {
    this.log('error', message, context);
  }

  // Specialized logging methods
  logTransaction(message: string, txId: string, boxIds: string[], rentCollected: bigint, fee: bigint): void {
    this.winston.log('info', message, {
      component: 'transaction',
      txId,
      boxIds,
      rentCollected: rentCollected.toString(),
      fee: fee.toString(),
      timestamp: new Date().toISOString()
    });
  }

  logBoxProcessing(message: string, boxId: string, rentFee: bigint, status: string): void {
    this.winston.log('info', message, {
      component: 'box-processing',
      boxId,
      rentFee: rentFee.toString(),
      status,
      timestamp: new Date().toISOString()
    });
  }

  logScanResult(message: string, scannedCount: number, eligibleCount: number, currentHeight: number, duration: number): void {
    this.winston.log('info', message, {
      component: 'scanner',
      scannedCount,
      eligibleCount,
      currentHeight,
      duration,
      timestamp: new Date().toISOString()
    });
  }

  logMetrics(metrics: Record<string, any>): void {
    this.winston.log('info', 'Bot metrics', {
      component: 'metrics',
      ...metrics,
      timestamp: new Date().toISOString()
    });
  }

  // Performance timing helper
  time(label: string): () => void {
    const start = Date.now();
    return () => {
      const duration = Date.now() - start;
      this.debug(`Timer: ${label}`, { component: 'performance', duration });
    };
  }

  // Create child logger with default context
  child(defaultContext: Partial<LogContext>): Logger {
    const childLogger = Object.create(this);
    const originalLog = this.log.bind(this);
    
    childLogger.log = (level: LogLevel, message: string, context?: LogContext) => {
      const mergedContext: LogContext = { 
        component: defaultContext.component || 'unknown',
        ...defaultContext, 
        ...context 
      };
      originalLog(level, message, mergedContext);
    };
    
    return childLogger;
  }

  // Graceful shutdown
  async close(): Promise<void> {
    return new Promise((resolve) => {
      this.winston.on('finish', resolve);
      this.winston.end();
    });
  }
}

// Create and export singleton logger instance
let loggerInstance: Logger | null = null;

export function createLogger(logLevel: LogLevel = 'info', logDir: string = './logs'): Logger {
  if (!loggerInstance) {
    loggerInstance = new Logger(logLevel, logDir);
  }
  return loggerInstance;
}

export function getLogger(): Logger {
  if (!loggerInstance) {
    loggerInstance = new Logger();
  }
  return loggerInstance;
}

// Legacy exports for compatibility
export const logger = createLogger('info', './logs');
export const scanLogger = logger;
export const transactionLogger = logger;
export const walletLogger = logger;

// Export the Logger class for testing
export { Logger }; 