import pino from 'pino';

// One JSON object per line on stdout. The awslogs driver ships stdout to
// CloudWatch Logs, where Logs Insights can query the fields directly.
export function createLogger(level = 'info') {
  return pino({
    level,
    base: { service: 'ha-notes-api' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
    redact: ['req.headers.authorization', 'req.headers.cookie'],
  });
}
