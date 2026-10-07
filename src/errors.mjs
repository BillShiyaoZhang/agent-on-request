export class AppError extends Error {
  constructor(code, message, status = 400, details) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}
export function requireThat(condition, code, message, status = 400, details) {
  if (!condition) throw new AppError(code, message, status, details);
}
