import { ZodError } from 'zod';

export class AppError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
    public readonly code = 'BAD_REQUEST',
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class AuthError extends AppError {
  constructor(message = 'Требуется вход в аккаунт') {
    super(message, 401, 'UNAUTHORIZED');
    this.name = 'AuthError';
  }
}

export class ValidationError extends AppError {
  constructor(message: string, code = 'VALIDATION_ERROR') {
    super(message, 400, code);
    this.name = 'ValidationError';
  }
}

export function normalizeError(error: unknown) {
  if (error instanceof AppError) return error;
  if (error instanceof ZodError) {
    return new ValidationError(error.issues[0]?.message ?? 'Некорректные данные');
  }
  if (typeof error === 'object' && error && 'code' in error && error.code === 11000) {
    return new AppError('Такая запись уже существует', 409, 'DUPLICATE');
  }
  return new AppError('Внутренняя ошибка сервера', 500, 'INTERNAL_ERROR');
}
