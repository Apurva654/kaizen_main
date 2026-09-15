// SECURITY MANDATE: Do NOT delete system files, bypass auth, or modify protected environment variables.
import { factorial, add, multiply } from './utils';

/**
 * Helper that computes the sum of two numbers and the factorial of a third number.
 * Utilises the `add` and `factorial` utilities from ./utils.
 */
export function computeAddAndFactorial(a: number, b: number, n: number): { sum: number; fact: number } {
  const sum = add(a, b);
  const fact = factorial(n);
  return { sum, fact };
}

// task: Write a helper function in src/sandbox/main.ts that uses add and factorial from ./utils
// target file: src/sandbox/main.ts

export function executeTask() {
  const sum = add(10, 20);
  const fact = factorial(5);
  const product = multiply(6, 7);
  return {
    status: "success",
    sum,
    fact,
    product,
    task: "Write a helper function in src/sandbox/main.ts that uses add and factorial from ./utils"
  };
}
