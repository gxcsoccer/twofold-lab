import { decimal, type DecimalString } from "./decimal.js";

export type DecimalInput = DecimalString | string;
export type DecimalRoundingMode = "HALF_UP" | "DOWN";

interface ParsedDecimal {
  readonly coefficient: bigint;
  readonly scale: number;
}

const DECIMAL_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.(\d+))?$/;

function powerOfTen(exponent: number): bigint {
  if (!Number.isSafeInteger(exponent) || exponent < 0) {
    throw new RangeError(`Invalid decimal exponent: ${exponent}`);
  }
  return 10n ** BigInt(exponent);
}

function parse(value: DecimalInput): ParsedDecimal {
  if (typeof value !== "string") {
    throw new TypeError("Decimal values must cross boundaries as strings");
  }
  const match = DECIMAL_PATTERN.exec(value);
  if (!match) throw new TypeError(`Invalid canonical decimal string: ${value}`);

  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [whole = "0", fraction = ""] = unsigned.split(".");
  const magnitude = BigInt(`${whole}${fraction}`);

  return {
    coefficient: negative && magnitude !== 0n ? -magnitude : magnitude,
    scale: fraction.length,
  };
}

function format(input: ParsedDecimal): DecimalString {
  let coefficient = input.coefficient;
  let scale = input.scale;

  while (scale > 0 && coefficient % 10n === 0n) {
    coefficient /= 10n;
    scale -= 1;
  }

  const negative = coefficient < 0n;
  const digits = (negative ? -coefficient : coefficient).toString();
  if (scale === 0) return decimal(`${negative ? "-" : ""}${digits}`);

  const padded = digits.padStart(scale + 1, "0");
  const split = padded.length - scale;
  return decimal(
    `${negative ? "-" : ""}${padded.slice(0, split)}.${padded.slice(split)}`,
  );
}

function align(
  left: ParsedDecimal,
  right: ParsedDecimal,
): readonly [bigint, bigint, number] {
  const scale = Math.max(left.scale, right.scale);
  return [
    left.coefficient * powerOfTen(scale - left.scale),
    right.coefficient * powerOfTen(scale - right.scale),
    scale,
  ];
}

function roundedQuotient(
  numerator: bigint,
  denominator: bigint,
  mode: DecimalRoundingMode,
): bigint {
  if (denominator <= 0n) throw new RangeError("Decimal denominator must be positive");

  const negative = numerator < 0n;
  const magnitude = negative ? -numerator : numerator;
  let quotient = magnitude / denominator;
  const remainder = magnitude % denominator;

  if (mode === "HALF_UP" && remainder * 2n >= denominator) quotient += 1n;
  return negative ? -quotient : quotient;
}

export function normalizeDecimal(value: DecimalInput): DecimalString {
  return format(parse(value));
}

export function compareDecimals(left: DecimalInput, right: DecimalInput): number {
  const [leftCoefficient, rightCoefficient] = align(parse(left), parse(right));
  if (leftCoefficient === rightCoefficient) return 0;
  return leftCoefficient < rightCoefficient ? -1 : 1;
}

export function addDecimals(
  left: DecimalInput,
  right: DecimalInput,
): DecimalString {
  const [leftCoefficient, rightCoefficient, scale] = align(parse(left), parse(right));
  return format({ coefficient: leftCoefficient + rightCoefficient, scale });
}

export function sumDecimals(values: readonly DecimalInput[]): DecimalString {
  return values.reduce<DecimalString>(
    (total, value) => addDecimals(total, value),
    decimal("0"),
  );
}

export function subtractDecimals(
  left: DecimalInput,
  right: DecimalInput,
): DecimalString {
  const parsedRight = parse(right);
  return addDecimals(left, format({
    coefficient: -parsedRight.coefficient,
    scale: parsedRight.scale,
  }));
}

export function multiplyDecimals(
  left: DecimalInput,
  right: DecimalInput,
): DecimalString {
  const parsedLeft = parse(left);
  const parsedRight = parse(right);
  return format({
    coefficient: parsedLeft.coefficient * parsedRight.coefficient,
    scale: parsedLeft.scale + parsedRight.scale,
  });
}

export function divideDecimals(
  dividend: DecimalInput,
  divisor: DecimalInput,
  resultScale: number,
  mode: DecimalRoundingMode = "HALF_UP",
): DecimalString {
  if (!Number.isSafeInteger(resultScale) || resultScale < 0) {
    throw new RangeError(`Invalid result scale: ${resultScale}`);
  }

  const left = parse(dividend);
  const right = parse(divisor);
  if (right.coefficient === 0n) throw new RangeError("Cannot divide by zero");

  const sign = right.coefficient < 0n ? -1n : 1n;
  const exponent = right.scale - left.scale + resultScale;
  const numerator = exponent >= 0
    ? left.coefficient * sign * powerOfTen(exponent)
    : left.coefficient * sign;
  const denominator = (right.coefficient < 0n ? -right.coefficient : right.coefficient)
    * (exponent < 0 ? powerOfTen(-exponent) : 1n);

  return format({
    coefficient: roundedQuotient(numerator, denominator, mode),
    scale: resultScale,
  });
}

export function roundDecimal(
  value: DecimalInput,
  resultScale: number,
  mode: DecimalRoundingMode = "HALF_UP",
): DecimalString {
  if (!Number.isSafeInteger(resultScale) || resultScale < 0) {
    throw new RangeError(`Invalid result scale: ${resultScale}`);
  }

  const parsed = parse(value);
  if (parsed.scale <= resultScale) return format(parsed);

  const denominator = powerOfTen(parsed.scale - resultScale);
  return format({
    coefficient: roundedQuotient(parsed.coefficient, denominator, mode),
    scale: resultScale,
  });
}

export function minDecimal(
  left: DecimalInput,
  right: DecimalInput,
): DecimalString {
  return compareDecimals(left, right) <= 0
    ? normalizeDecimal(left)
    : normalizeDecimal(right);
}

export function maxDecimal(
  left: DecimalInput,
  right: DecimalInput,
): DecimalString {
  return compareDecimals(left, right) >= 0
    ? normalizeDecimal(left)
    : normalizeDecimal(right);
}

export function negateDecimal(value: DecimalInput): DecimalString {
  const parsed = parse(value);
  return format({ coefficient: -parsed.coefficient, scale: parsed.scale });
}

export function absoluteDecimal(value: DecimalInput): DecimalString {
  const parsed = parse(value);
  return format({
    coefficient: parsed.coefficient < 0n ? -parsed.coefficient : parsed.coefficient,
    scale: parsed.scale,
  });
}
