import { runPipeline } from './server';
import { memoryEngine } from './context/memory/memoryEngine';
import { KaizenStateType } from './state';

/**
 * CLI Unified Agent Pipeline Execution Runner
 * Eliminates pipeline logic duplication and drift by delegating directly to the unified runPipeline engine.
 */
export async function executeAgentPipeline(userInput: string): Promise<KaizenStateType> {
  memoryEngine.stateMemory.clearState();
  console.log(`\n=========================================`);
  console.log(`User Input: "${userInput}"`);
  console.log(`=========================================`);

  return await runPipeline(userInput, undefined, undefined, (eventType: string, data: any) => {
    if (eventType === 'agent_step') {
      const msg = data.message || data.status || '';
      console.log(`-> [${data.agent || 'Agent'}] ${msg}`);
    } else if (eventType === 'hitl_request') {
      console.log(`\n[HITL Prompt]: ${data.title || 'Action Required'} - ${data.message || ''}`);
    } else if (eventType === 'pipeline_complete') {
      console.log(`\n=========================================`);
      console.log(`=== Pipeline Completed: Status ${data.status} ===`);
      if (data.explanation) {
        console.log(`\n${data.explanation}`);
      }
      if (data.targetFiles && data.targetFiles.length > 0) {
        console.log(`Target files: ${data.targetFiles.join(', ')}`);
      }
      console.log(`=========================================\n`);
    }
  });
}

async function runDemo() {
  const args = process.argv.slice(2);
  const cliQuery = args.join(' ').trim();

  if (!cliQuery) {
    console.warn("Error: No query provided. Please provide a query in the terminal.");
    console.log('Example: npm start -- "Write a greeting function"');
    process.exit(1);
  }

  console.log("=== KAIZEN RUNNING USER QUERY ===");
  await executeAgentPipeline(cliQuery);
}

if (typeof require !== 'undefined' && require.main === module) {
  runDemo().catch(err => {
    console.error("Pipeline run failed:", err);
    process.exit(1);
  });
}
