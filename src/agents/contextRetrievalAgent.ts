import * as path from 'path';
import * as fs from 'fs';
import { KaizenState } from '../state';
import { GraphifyEngine } from '../tools/graphifyEngine';

export async function contextRetrievalAgentNode(state: typeof KaizenState.State) {
  let targetFiles = state.targetFiles && state.targetFiles.length > 0 
    ? state.targetFiles 
    : ['src/sandbox/main.ts'];

  targetFiles = targetFiles.map(f => f.replace(/\\/g, '/'));

  const engine = new GraphifyEngine();

  // Determine workspace/sandbox directory to scan
  let scanDir = 'src/sandbox';
  if (targetFiles[0]) {
    const targetDir = path.dirname(targetFiles[0]);
    if (fs.existsSync(targetDir)) {
      scanDir = targetDir;
    }
  }

  // Scan workspace folder with GraphifyEngine
  await engine.scanDirectory(scanDir);

  // Also scan src/sandbox if targetDir was different but sandbox exists
  if (scanDir !== 'src/sandbox' && fs.existsSync('src/sandbox')) {
    await engine.scanDirectory('src/sandbox');
  }

  // Build clean extracted context from dependency tree and symbol facts
  const extractedContext = engine.buildContextSummary(targetFiles);

  console.log(`[ContextRetrievalAgent] Successfully scanned workspace '${scanDir}'. Target files: ${targetFiles.join(', ')}`);

  return {
    targetFiles,
    extractedContext,
    status: "CONTEXT_RETRIEVED"
  };
}
