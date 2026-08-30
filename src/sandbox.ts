/**
 * Computes factorial of a non‑negative integer using an iterative approach.
 * @param n - The number to compute the factorial for (0 ≤ n ≤ 20).
 * @returns The factorial of n.
 */
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

/**
 * Generates an array containing the factorials of the first `count` natural numbers (starting at 1).
 * @param count - How many factorials to generate.
 * @returns Array of factorial values.
 */
export function firstNFactorials(count: number): number[] {
  if (count < 0) {
    throw new RangeError('Count must be non‑negative');
  }
  const result: number[] = [];
  for (let i = 1; i <= count; i++) {
    result.push(factorial(i));
  }
  return result;
}

/**
 * Adds two numbers and returns the sum.
 * @param a - First operand.
 * @param b - Second operand.
 * @returns The arithmetic sum of `a` and `b`.
 */
export function add(a: number, b: number): number {
  return a + b;
}

// Example usage: compute factorials of the first 10 natural numbers and demonstrate addition.
if (require.main === module) {
  const factorials = firstNFactorials(10);
  console.log('Factorials of the first 10 natural numbers:');
  factorials.forEach((value, index) => {
    console.log(`${index + 1}! = ${value}`);
  });

  // Demonstrate the add function
  const sum = add(7, 5);
  console.log('Example addition: 7 + 5 =', sum);
}
