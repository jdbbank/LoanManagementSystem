/** Container-style logging: stdout is what the orchestrator collects. */
function line(level: string, message: string, extra?: unknown): void {
  const stamp = new Date().toISOString();
  const tail = extra === undefined ? '' : ` ${JSON.stringify(extra)}`;
  // eslint-disable-next-line no-console
  console.log(`${stamp} [${level.padEnd(5)}] [mailer] ${message}${tail}`);
}

export const log = {
  info: (message: string, extra?: unknown) => line('info', message, extra),
  warn: (message: string, extra?: unknown) => line('warn', message, extra),
  error: (message: string, error?: unknown) =>
    line('error', message, {
      reason: error instanceof Error ? error.message : error,
    }),
};
