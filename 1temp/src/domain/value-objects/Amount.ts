export class Amount {
  private constructor(private readonly _value: number) {
    if (_value < 0) {
      throw new Error('Amount must be non-negative');
    }
  }

  static create(value: number): Amount {
    return new Amount(value);
  }

  static zero(): Amount {
    return new Amount(0);
  }

  get value(): number {
    return this._value;
  }

  add(other: Amount): Amount {
    return Amount.create(this._value + other._value);
  }

  subtract(other: Amount): Amount {
    const result = this._value - other._value;
    if (result < 0) {
      throw new Error('Result cannot be negative');
    }
    return Amount.create(result);
  }

  multiply(factor: number): Amount {
    return Amount.create(this._value * factor);
  }

  divide(divisor: number): Amount {
    if (divisor === 0) {
      throw new Error('Cannot divide by zero');
    }
    return Amount.create(this._value / divisor);
  }

  equals(other: Amount): boolean {
    return this._value === other._value;
  }

  isGreaterThan(other: Amount): boolean {
    return this._value > other._value;
  }

  isLessThan(other: Amount): boolean {
    return this._value < other._value;
  }

  isZero(): boolean {
    return this._value === 0;
  }
}



