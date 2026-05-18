export type ErrorDetails = Record<string, unknown>;

export class AppError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly details?: ErrorDetails;

  constructor(
    code: string,
    message: string,
    httpStatus: number,
    details?: ErrorDetails,
  ) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.httpStatus = httpStatus;
    if (details !== undefined) this.details = details;
  }
}

export class BadRequest extends AppError {
  constructor(message = 'Bad request', code = 'bad_request', details?: ErrorDetails) {
    super(code, message, 400, details);
  }
}

export class Unauthorized extends AppError {
  constructor(message = 'Authentication required', code = 'auth_required', details?: ErrorDetails) {
    super(code, message, 401, details);
  }
}

export class Forbidden extends AppError {
  constructor(message = 'Forbidden', code = 'forbidden', details?: ErrorDetails) {
    super(code, message, 403, details);
  }
}

export class NotFound extends AppError {
  constructor(message = 'Not found', code = 'not_found', details?: ErrorDetails) {
    super(code, message, 404, details);
  }
}

export class Conflict extends AppError {
  constructor(message = 'Conflict', code = 'conflict', details?: ErrorDetails) {
    super(code, message, 409, details);
  }
}

export class RateLimit extends AppError {
  constructor(message = 'Rate limit exceeded', code = 'rate_limited', details?: ErrorDetails) {
    super(code, message, 429, details);
  }
}

export class Upstream extends AppError {
  constructor(message = 'Upstream error', code = 'upstream_error', details?: ErrorDetails) {
    super(code, message, 502, details);
  }
}
