export function factorial(n: number): number {
  if (n < 0) {
    throw new RangeError('Factorial is not defined for negative numbers');
  }
  let result = 1;
  for (let i = 2; i <= n; i++) {
    result *= i;
  }
  return result;
}

export function firstNFactorials(count: number): number[] {
  if (count < 0) {
    throw new RangeError('Count must be non-negative');
  }
  const result: number[] = [];
  for (let i = 1; i <= count; i++) {
    result.push(factorial(i));
  }
  return result;
}

export function add(a: number, b: number): number {
  return a + b;
}

export function multiply(a: number, b: number): number {
  return a * b;
}
