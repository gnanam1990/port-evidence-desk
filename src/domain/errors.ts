/** Domain and HTTP errors surfaced with stable decision codes. */
export class ApiError extends Error {
  status: number;
  code: string;
  detail?: unknown;

  constructor(status: number, code: string, message: string, detail?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

export const badRequest = (code: string, msg: string, detail?: unknown) =>
  new ApiError(400, code, msg, detail);
export const unauthorized = (msg = 'authentication required') => new ApiError(401, 'unauthorized', msg);
export const forbidden = (code: string, msg: string) => new ApiError(403, code, msg);
export const notFound = (code: string, msg: string) => new ApiError(404, code, msg);
export const conflict = (code: string, msg: string, detail?: unknown) =>
  new ApiError(409, code, msg, detail);
export const unprocessable = (code: string, msg: string, detail?: unknown) =>
  new ApiError(422, code, msg, detail);
