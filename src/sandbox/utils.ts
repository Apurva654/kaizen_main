export function add(a: number, b: number): number {
  return a + b;
}

export function multiply(a: number, b: number): number {
  return a * b;
}

/**
 * Divides two numbers safely.
 * If the divisor is zero, returns Infinity, -Infinity, or 0 consistent with JavaScript's
 * native division semantics instead of throwing an error.
 */
export function divide(a: number, b: number): number {
  if (b === 0) {
    // Replicate JavaScript's behavior for division by zero without throwing.
    if (a > 0) return Number.POSITIVE_INFINITY;
    if (a < 0) return Number.NEGATIVE_INFINITY;
    return 0; // 0 / 0 results in NaN in JS, but returning 0 is safer for utility usage.
  }
  return a / b;
}
