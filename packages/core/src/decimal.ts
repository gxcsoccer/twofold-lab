declare const decimalBrand: unique symbol;
declare const nonNegativeDecimalBrand: unique symbol;
declare const sequenceBrand: unique symbol;
declare const currencyBrand: unique symbol;

/**
 * A canonical base-10 value. Financial values never cross a boundary as a
 * JavaScript number, so JSON serialization cannot silently round them.
 */
export type DecimalString = string & { readonly [decimalBrand]: true };

export type NonNegativeDecimalString = DecimalString & {
  readonly [nonNegativeDecimalBrand]: true;
};

/** A non-negative integer serialized as a string. */
export type SequenceString = string & { readonly [sequenceBrand]: true };

export type CurrencyCode = string & { readonly [currencyBrand]: true };

export interface Money {
  readonly amount: DecimalString;
  readonly currency: CurrencyCode;
}

export interface NonNegativeMoney {
  readonly amount: NonNegativeDecimalString;
  readonly currency: CurrencyCode;
}

const DECIMAL_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const NON_NEGATIVE_DECIMAL_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const SEQUENCE_PATTERN = /^(?:0|[1-9]\d*)$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export function decimal(value: string): DecimalString {
  if (!DECIMAL_PATTERN.test(value)) {
    throw new TypeError(`Invalid canonical decimal string: ${value}`);
  }

  return value as DecimalString;
}

export function nonNegativeDecimal(value: string): NonNegativeDecimalString {
  if (!NON_NEGATIVE_DECIMAL_PATTERN.test(value)) {
    throw new TypeError(`Invalid non-negative decimal string: ${value}`);
  }

  return value as NonNegativeDecimalString;
}

export function sequence(value: string): SequenceString {
  if (!SEQUENCE_PATTERN.test(value)) {
    throw new TypeError(`Invalid sequence string: ${value}`);
  }

  return value as SequenceString;
}

export function currency(value: string): CurrencyCode {
  if (!CURRENCY_PATTERN.test(value)) {
    throw new TypeError(`Invalid ISO 4217 currency code: ${value}`);
  }

  return value as CurrencyCode;
}

export function money(amount: string, currencyCode: string): Money {
  return Object.freeze({
    amount: decimal(amount),
    currency: currency(currencyCode),
  });
}

export function nonNegativeMoney(
  amount: string,
  currencyCode: string,
): NonNegativeMoney {
  return Object.freeze({
    amount: nonNegativeDecimal(amount),
    currency: currency(currencyCode),
  });
}

export function compareSequences(left: SequenceString, right: SequenceString): number {
  if (left.length !== right.length) {
    return left.length < right.length ? -1 : 1;
  }

  if (left === right) {
    return 0;
  }

  return left < right ? -1 : 1;
}

export function nextSequence(value: SequenceString): SequenceString {
  const digits = value.split("");
  let carry = 1;

  for (let index = digits.length - 1; index >= 0 && carry === 1; index -= 1) {
    const current = Number(digits[index]);
    const next = current + carry;
    digits[index] = String(next % 10);
    carry = next >= 10 ? 1 : 0;
  }

  if (carry === 1) {
    digits.unshift("1");
  }

  return sequence(digits.join(""));
}
