export function add(a: number, b: number): number {
  return a + b;
}

export function multiply(a: number, b: number): number {
  return a * b;
}

export function divide(a: number, b: number): number {
  if (b === 0) {
    if (a > 0) return Number.POSITIVE_INFINITY;
    if (a < 0) return Number.NEGATIVE_INFINITY;
    return Number.NaN;
  }
  return a / b;
}

export function factorial(n: number): number {
  if (n <= 1) return 1;
  return n * factorial(n - 1);
}

export function sum(values: number[]): number {
  return values.reduce((acc, cur) => add(acc, cur), 0);
}

export function mean(values: number[]): number {
  if (!values || values.length === 0) return 0;
  return divide(sum(values), values.length);
}

export function max(values: number[]): number {
  if (!values || values.length === 0) return Number.NEGATIVE_INFINITY;
  return values.reduce((m, v) => (v > m ? v : m), values[0]);
}

export function min(values: number[]): number {
  if (!values || values.length === 0) return Number.POSITIVE_INFINITY;
  return values.reduce((m, v) => (v < m ? v : m), values[0]);
}

export function formatCurrency(
  value: number,
  locale: string = 'en-US',
  currency: string = 'USD'
): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(value);
}

// --- CSV Parsing, Data Cleaning, and Imputation Helpers ---

export interface DataRecord {
  id: string;
  category: string;
  value: number | null;
  timestamp: string;
}

/**
 * Custom CSV parser helper function.
 */
export function parseCSV(rawCsv: string): DataRecord[] {
  const lines = rawCsv.split(/\r?\n/).filter(line => line.trim().length > 0);
  if (lines.length <= 1) return [];

  const records: DataRecord[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map(c => c.trim());
    if (cols.length >= 3) {
      const rawVal = cols[2];
      const parsedVal = rawVal === '' || rawVal.toLowerCase() === 'null' || rawVal.toLowerCase() === 'undefined'
        ? null
        : parseFloat(rawVal);

      records.push({
        id: cols[0] || `ID_${i}`,
        category: cols[1] || 'Uncategorized',
        value: isNaN(parsedVal as number) ? null : parsedVal,
        timestamp: cols[3] || new Date().toISOString()
      });
    }
  }
  return records;
}

/**
 * Data cleaning and null-value imputer helper.
 */
export function cleanAndImputeRecords(records: DataRecord[]): DataRecord[] {
  const validValues = records.map(r => r.value).filter((v): v is number => v !== null && !isNaN(v));
  const imputedValue = validValues.length > 0 ? mean(validValues) : 0;

  return records.map(r => ({
    ...r,
    value: r.value === null ? Number(imputedValue.toFixed(2)) : r.value
  }));
}
