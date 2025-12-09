import { Result, Success, Failure } from './Result';

describe('Result', () => {
  describe('Success', () => {
    it('should create success with value', () => {
      const result = Result.success(42);
      expect(result.isSuccess).toBe(true);
      expect(result.isFailure).toBe(false);
      if (result.isSuccess) {
        expect(result.value).toBe(42);
      }
    });

    it('should extract value', () => {
      const result = Result.success('test');
      if (result.isSuccess) {
        expect(result.value).toBe('test');
      }
    });

    it('should map value', () => {
      const result = Result.success(5);
      const mapped = result.map((x) => x * 2);
      expect(mapped.isSuccess).toBe(true);
      if (mapped.isSuccess) {
        expect(mapped.value).toBe(10);
      }
    });

    it('should flatMap to another result', () => {
      const result = Result.success(5);
      const flatMapped = result.flatMap((x) => Result.success(x * 2));
      expect(flatMapped.isSuccess).toBe(true);
      if (flatMapped.isSuccess) {
        expect(flatMapped.value).toBe(10);
      }
    });

    it('should flatMap to failure', () => {
      const result = Result.success(5);
      const flatMapped = result.flatMap(() => Result.failure(new Error('test')));
      expect(flatMapped.isFailure).toBe(true);
      if (flatMapped.isFailure) {
        expect(flatMapped.error.message).toBe('test');
      }
    });

    it('should map error (no-op for success)', () => {
      const result = Result.success(42);
      const mapped = result.mapError((e) => new Error('new error'));
      expect(mapped.isSuccess).toBe(true);
      if (mapped.isSuccess) {
        expect(mapped.value).toBe(42);
      }
    });

    it('should fold to value', () => {
      const result = Result.success(42);
      const folded = result.fold(
        (value) => `Success: ${value}`,
        (error) => `Error: ${error.message}`,
      );
      expect(folded).toBe('Success: 42');
    });

    it('should get or else default', () => {
      const result = Result.success(42);
      expect(result.getOrElse(0)).toBe(42);
    });

    it('should get or throw', () => {
      const result = Result.success(42);
      expect(result.getOrThrow()).toBe(42);
    });
  });

  describe('Failure', () => {
    it('should create failure with error', () => {
      const error = new Error('test error');
      const result = Result.failure(error);
      expect(result.isSuccess).toBe(false);
      expect(result.isFailure).toBe(true);
      if (result.isFailure) {
        expect(result.error).toBe(error);
      }
    });

    it('should extract error', () => {
      const error = new Error('test');
      const result = Result.failure(error);
      if (result.isFailure) {
        expect(result.error).toBe(error);
      }
    });

    it('should map value (no-op for failure)', () => {
      const result = Result.failure(new Error('test'));
      const mapped = result.map((x: any) => x * 2);
      expect(mapped.isFailure).toBe(true);
      if (mapped.isFailure) {
        expect(mapped.error.message).toBe('test');
      }
    });

    it('should flatMap (no-op for failure)', () => {
      const result = Result.failure(new Error('test'));
      const flatMapped = result.flatMap((x: any) => Result.success(x * 2));
      expect(flatMapped.isFailure).toBe(true);
      if (flatMapped.isFailure) {
        expect(flatMapped.error.message).toBe('test');
      }
    });

    it('should map error', () => {
      const result = Result.failure(new Error('original'));
      const mapped = result.mapError((e) => new Error(`new: ${e.message}`));
      expect(mapped.isFailure).toBe(true);
      if (mapped.isFailure) {
        expect(mapped.error.message).toBe('new: original');
      }
    });

    it('should fold to error', () => {
      const result = Result.failure(new Error('test'));
      const folded = result.fold(
        (value) => `Success: ${value}`,
        (error) => `Error: ${error.message}`,
      );
      expect(folded).toBe('Error: test');
    });

    it('should get or else default', () => {
      const result = Result.failure(new Error('test'));
      expect(result.getOrElse(0)).toBe(0);
    });

    it('should get or throw', () => {
      const result = Result.failure(new Error('test'));
      expect(() => result.getOrThrow()).toThrow('test');
    });
  });

  describe('fromPromise', () => {
    it('should create success from resolved promise', async () => {
      const promise = Promise.resolve(42);
      const result = await Result.fromPromise(promise);
      expect(result.isSuccess).toBe(true);
      if (result.isSuccess) {
        expect(result.value).toBe(42);
      }
    });

    it('should create failure from rejected promise', async () => {
      const promise = Promise.reject(new Error('test'));
      const result = await Result.fromPromise(promise);
      expect(result.isFailure).toBe(true);
      if (result.isFailure) {
        expect(result.error.message).toBe('test');
      }
    });
  });

  describe('fromNullable', () => {
    it('should create success from non-null value', () => {
      const result = Result.fromNullable(42, new Error('null'));
      expect(result.isSuccess).toBe(true);
      if (result.isSuccess) {
        expect(result.value).toBe(42);
      }
    });

    it('should create failure from null', () => {
      const result = Result.fromNullable(null, new Error('null'));
      expect(result.isFailure).toBe(true);
      if (result.isFailure) {
        expect(result.error.message).toBe('null');
      }
    });

    it('should create failure from undefined', () => {
      const result = Result.fromNullable(undefined, new Error('undefined'));
      expect(result.isFailure).toBe(true);
      if (result.isFailure) {
        expect(result.error.message).toBe('undefined');
      }
    });
  });

  describe('combine', () => {
    it('should combine multiple successes', () => {
      const results = [
        Result.success(1),
        Result.success(2),
        Result.success(3),
      ];
      const combined = Result.combine(results);
      expect(combined.isSuccess).toBe(true);
      if (combined.isSuccess) {
        expect(combined.value).toEqual([1, 2, 3]);
      }
    });

    it('should combine with failures', () => {
      const results = [
        Result.success(1),
        Result.failure(new Error('error1')),
        Result.success(3),
        Result.failure(new Error('error2')),
      ];
      const combined = Result.combine(results);
      expect(combined.isFailure).toBe(true);
      if (combined.isFailure) {
        expect(combined.error.message).toContain('error1');
        expect(combined.error.message).toContain('error2');
      }
    });

    it('should return success for empty array', () => {
      const combined = Result.combine([]);
      expect(combined.isSuccess).toBe(true);
      if (combined.isSuccess) {
        expect(combined.value).toEqual([]);
      }
    });
  });
});
