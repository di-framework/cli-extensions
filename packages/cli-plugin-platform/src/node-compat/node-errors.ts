/**
 * Node-shaped argument errors for the overlays. Messages follow Node v22's
 * `ERR_OUT_OF_RANGE` / `ERR_INVALID_ARG_TYPE` / `ERR_INVALID_ARG_VALUE` text, including the
 * `1_000_000` separators Node prints for values beyond 2**32. Do not import WASI from here.
 */

type CodedError<E extends Error> = E & { code: string };

function coded<E extends Error>(error: E, code: string): CodedError<E> {
  return Object.assign(error, { code });
}

function addNumericalSeparator(value: string): string {
  let result = '';
  let i = value.length;
  const start = value.startsWith('-') ? 1 : 0;
  for (; i >= start + 4; i -= 3) result = `_${value.slice(i - 3, i)}${result}`;
  return `${value.slice(0, i)}${result}`;
}

function formatRangeReceived(value: unknown): string {
  if (typeof value === 'number' && Number.isInteger(value) && Math.abs(value) > 2 ** 32) {
    return addNumericalSeparator(String(value));
  }
  if (typeof value === 'bigint') {
    const text = String(value);
    return `${value > 2n ** 32n || value < -(2n ** 32n) ? addNumericalSeparator(text) : text}n`;
  }
  return String(value);
}

function formatTypeReceived(value: unknown): string {
  if (value === null || value === undefined) return `Received ${value}`;
  if (typeof value === 'function') return `Received function ${value.name}`;
  if (typeof value === 'object') {
    const name = (value as { constructor?: { name?: string } }).constructor?.name;
    return name ? `Received an instance of ${name}` : 'Received [Object: null prototype] {}';
  }
  let shown: string;
  if (typeof value === 'string') {
    shown = `'${value.length > 28 ? `${value.slice(0, 25)}...` : value}'`;
  } else if (typeof value === 'bigint') {
    shown = `${value}n`;
  } else {
    shown = String(value);
  }
  return `Received type ${typeof value} (${shown})`;
}

/** `ERR_OUT_OF_RANGE`: `The value of "<name>" is out of range. It must be <range>. Received …`. */
export function outOfRange(name: string, range: string, received: unknown): CodedError<RangeError> {
  return coded(
    new RangeError(
      `The value of "${name}" is out of range. It must be ${range}. Received ${formatRangeReceived(received)}`,
    ),
    'ERR_OUT_OF_RANGE',
  );
}

/** `ERR_INVALID_ARG_TYPE`; `expected` is Node's phrase, e.g. `of type number`. */
export function invalidArgType(
  name: string,
  expected: string,
  received: unknown,
): CodedError<TypeError> {
  return coded(
    new TypeError(`The "${name}" argument must be ${expected}. ${formatTypeReceived(received)}`),
    'ERR_INVALID_ARG_TYPE',
  );
}

/** `ERR_INVALID_ARG_VALUE`: `The argument '<name>' <reason>. Received …`. */
export function invalidArgValue(
  name: string,
  reason: string,
  received: string,
): CodedError<TypeError> {
  return coded(
    new TypeError(`The argument '${name}' ${reason}. Received ${received}`),
    'ERR_INVALID_ARG_VALUE',
  );
}

/**
 * Node's `validateInteger(value, name, min)`: a number, an integer, and within
 * `[min, Number.MAX_SAFE_INTEGER]`.
 */
export function validateInteger(value: unknown, name: string, min = Number.MIN_SAFE_INTEGER) {
  if (typeof value !== 'number') throw invalidArgType(name, 'of type number', value);
  if (!Number.isInteger(value)) throw outOfRange(name, 'an integer', value);
  if (value < min || value > Number.MAX_SAFE_INTEGER) {
    throw outOfRange(name, `>= ${min} && <= ${Number.MAX_SAFE_INTEGER}`, value);
  }
  return value;
}
