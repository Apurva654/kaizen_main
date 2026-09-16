import * as fs from 'fs';
import * as path from 'path';
import {
  DataRecord,
  parseCSV,
  cleanAndImputeRecords,
  sum,
  mean,
  max,
  min,
  formatCurrency,
  add,
  multiply,
  factorial
} from './utils';

export interface IngestionSummary {
  totalProcessedRecords: number;
  imputedRecordCount: number;
  totalValue: number;
  averageValue: number;
  maxValue: number;
  minValue: number;
  summaryTimestamp: string;
}

/**
 * Asynchronous Data Stream & CSV Transformer Pipeline.
 */
export async function runDataIngestionPipeline(csvPath?: string): Promise<IngestionSummary> {
  const defaultCsvPath = csvPath || path.join(__dirname, 'stream_dataset.csv');
  const reportPath = path.join(__dirname, 'ingestion_summary.json');

  console.log(`\n=================================================`);
  console.log(`ASYNC DATA STREAM & CSV TRANSFORMER PIPELINE`);
  console.log(`=================================================`);
  console.log(`Reading stream dataset from: ${defaultCsvPath}`);

  try {
    // 1. Handle missing dataset gracefully by generating sample stream dataset
    if (!fs.existsSync(defaultCsvPath)) {
      console.warn(`[Pipeline Warning] Dataset missing at '${defaultCsvPath}'. Auto-creating sample dataset...`);
      const sampleCsv = `id,category,value,timestamp\nREC001,Electronics,150.50,2026-09-01T10:00:00Z\nREC002,Furniture,null,2026-09-01T10:05:00Z\nREC003,Electronics,299.99,2026-09-01T10:10:00Z\nREC004,Groceries,,2026-09-01T10:15:00Z\nREC005,Furniture,450.00,2026-09-01T10:20:00Z\n`;
      await fs.promises.writeFile(defaultCsvPath, sampleCsv, 'utf-8');
    }

    // 2. Asynchronous file read
    const rawContent = await fs.promises.readFile(defaultCsvPath, 'utf-8');
    const rawRecords = parseCSV(rawContent);

    const initialNullCount = rawRecords.filter(r => r.value === null).length;
    const cleanedRecords = cleanAndImputeRecords(rawRecords);

    // 3. Aggregate values
    const values = cleanedRecords.map(r => r.value as number);
    const totalVal = sum(values);
    const avgVal = mean(values);
    const maxVal = max(values);
    const minVal = min(values);

    const summary: IngestionSummary = {
      totalProcessedRecords: cleanedRecords.length,
      imputedRecordCount: initialNullCount,
      totalValue: Number(totalVal.toFixed(2)),
      averageValue: Number(avgVal.toFixed(2)),
      maxValue: Number(maxVal.toFixed(2)),
      minValue: Number(minVal.toFixed(2)),
      summaryTimestamp: new Date().toISOString()
    };

    // 4. Asynchronously write output summary JSON report
    await fs.promises.writeFile(reportPath, JSON.stringify(summary, null, 2), 'utf-8');

    console.log(`\n--- INGESTION SUMMARY REPORT ---`);
    console.log(`Total Records Processed : ${summary.totalProcessedRecords}`);
    console.log(`Null Values Imputed    : ${summary.imputedRecordCount}`);
    console.log(`Total Aggregated Value : ${formatCurrency(summary.totalValue)}`);
    console.log(`Average Record Value   : ${formatCurrency(summary.averageValue)}`);
    console.log(`Max Record Value       : ${formatCurrency(summary.maxValue)}`);
    console.log(`Min Record Value       : ${formatCurrency(summary.minValue)}`);
    console.log(`Report Written To      : ${reportPath}`);
    console.log(`=================================================\n`);

    return summary;
  } catch (error: any) {
    console.error(`[Pipeline Error] Asynchronous execution failed:`, error?.message || error);
    throw error;
  }
}

export function executeTask() {
  const sumVal = add(10, 20);
  const prodVal = multiply(5, 4);
  const factVal = factorial(5);
  runDataIngestionPipeline().catch(console.error);
  return { status: "success", sum: sumVal, prod: prodVal, fact: factVal };
}

if (require.main === module) {
  runDataIngestionPipeline().catch(err => console.error("Unhandled Exception:", err));
}
