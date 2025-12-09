/**
 * Result type for functional error handling
 * Represents either a success (with value) or failure (with error)
 * Note: Using class-based approach for better type inference and static methods
 */

/**
 * Success variant of Result
 */
export class Success<T, E = Error> {
  readonly isSuccess = true as const;
  readonly isFailure = false as const;

  constructor(public readonly value: T) {}

  /**
   * Map the success value to another value
   */
  map<U>(fn: (value: T) => U): Result<U, E> {
    return Result.success(fn(this.value));
  }

  /**
   * FlatMap (bind) - chain operations that return Results
   */
  flatMap<U>(fn: (value: T) => Result<U, E>): Result<U, E> {
    return fn(this.value);
  }

  /**
   * Map error (no-op for success)
   */
  mapError<F>(fn: (error: E) => F): Result<T, F> {
    return Result.success(this.value);
  }

  /**
   * Fold - transform both success and failure cases
   */
  fold<U>(
    onSuccess: (value: T) => U,
    onFailure: (error: E) => U,
  ): U {
    return onSuccess(this.value);
  }

  /**
   * Get value or default (returns value for success)
   */
  getOrElse(defaultValue: T): T {
    return this.value;
  }

  /**
   * Get value or throw (returns value for success)
   */
  getOrThrow(): T {
    return this.value;
  }
}

/**
 * Failure variant of Result
 */
export class Failure<T, E = Error> {
  readonly isSuccess = false as const;
  readonly isFailure = true as const;

  constructor(public readonly error: E) {}

  /**
   * Map value (no-op for failure)
   */
  map<U>(fn: (value: T) => U): Result<U, E> {
    return Result.failure(this.error);
  }

  /**
   * FlatMap (no-op for failure)
   */
  flatMap<U>(fn: (value: T) => Result<U, E>): Result<U, E> {
    return Result.failure(this.error);
  }

  /**
   * Map error to another error type
   */
  mapError<F>(fn: (error: E) => F): Result<T, F> {
    return Result.failure(fn(this.error));
  }

  /**
   * Fold - transform both success and failure cases
   */
  fold<U>(
    onSuccess: (value: T) => U,
    onFailure: (error: E) => U,
  ): U {
    return onFailure(this.error);
  }

  /**
   * Get value or default (returns default for failure)
   */
  getOrElse(defaultValue: T): T {
    return defaultValue;
  }

  /**
   * Get value or throw (throws error for failure)
   */
  getOrThrow(): T {
    if (this.error instanceof Error) {
      throw this.error;
    }
    throw new Error(String(this.error));
  }
}

/**
 * Result type union
 */
export type Result<T, E = Error> = Success<T, E> | Failure<T, E>;

/**
 * Result factory and utility functions
 * Using namespace pattern to avoid type/class name collision
 */
export namespace Result {
  /**
   * Create a success result
   */
  export function success<T, E = Error>(value: T): Result<T, E> {
    return new Success(value);
  }

  /**
   * Create a failure result
   */
  export function failure<T, E = Error>(error: E): Result<T, E> {
    return new Failure(error);
  }

  /**
   * Convert a promise to a Result
   */
  export async function fromPromise<T, E = Error>(
    promise: Promise<T>,
  ): Promise<Result<T, E>> {
    try {
      const value = await promise;
      return Result.success(value);
    } catch (error) {
      return Result.failure(error as E);
    }
  }

  /**
   * Create Result from nullable value
   */
  export function fromNullable<T, E = Error>(
    value: T | null | undefined,
    error: E,
  ): Result<T, E> {
    if (value === null || value === undefined) {
      return Result.failure(error);
    }
    return Result.success(value);
  }

  /**
   * Combine multiple Results into one
   * Returns success with array of values if all succeed
   * Returns failure with combined error message if any fail
   */
  export function combine<T, E = Error>(
    results: Result<T, E>[],
  ): Result<T[], E> {
    const values: T[] = [];
    const errors: E[] = [];

    for (const result of results) {
      if (result.isSuccess) {
        values.push(result.value);
      } else {
        errors.push(result.error);
      }
    }

    if (errors.length > 0) {
      // Combine errors into a single error
      const errorMessages = errors
        .map((e) => (e instanceof Error ? e.message : String(e)))
        .join('; ');
      return Result.failure(
        (errors[0] instanceof Error
          ? new Error(errorMessages)
          : errorMessages) as E,
      );
    }

    return Result.success(values);
  }
}