import { add, divide } from './utils';

/**
 * Calculates the average of an array of numeric grades.
 * Returns 0 for an empty array to avoid division by zero.
 *
 * @param grades - An array of numbers representing student grades.
 * @returns The arithmetic mean of the provided grades.
 */
export function calculateAverage(grades: number[]): number {
  if (!grades || grades.length === 0) {
    return 0;
  }
  const total = grades.reduce((sum, grade) => add(sum, grade), 0);
  return divide(total, grades.length);
}
