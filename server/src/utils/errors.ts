export class AppError extends Error {
  status: number;
  details?: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const badRequest = (message: string, details?: unknown) => new AppError(400, message, details);
export const unauthorized = (message = 'Unauthorized') => new AppError(401, message);
export const forbidden = (message = 'Forbidden') => new AppError(403, message);
/** Call sites pass either a resource name ("Loan") or a full sentence; both must read as an error. */
export const notFound = (message = 'Resource') =>
  new AppError(404, /not found/i.test(message) ? message : `${message} not found`);
export const conflict = (message: string) => new AppError(409, message);
export const unprocessable = (message: string, details?: unknown) => new AppError(422, message, details);
