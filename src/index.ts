import * as fs from 'fs';
import * as path from 'path';
import { KaizenStateType } from './state';
import { intentAgentNode } from './agents/intentAgent';
import { contextRetrievalAgentNode } from './graph/agents/contextRetrievalAgent';
import { plannerAgentNode } from './agents/plannerAgent';
import { codeGenAgentNode, isProtectedFile } from './agents/codeGenAgent';

async function executeAgentPipeline(userInput: string) {
  console.log(`\n=========================================`);
  console.log(`User Input: "${userInput}"`);
  console.log(`=========================================`);

  // 1. Initialize State
  let state: KaizenStateType = {
    userInput,
    targetFiles: [],
    extractedContext: "",
    plan: [],
    generatedPatch: "",
    choices: [],
    retryCount: 0,
    status: "INITIALIZED"
  };

  // 2. Run Intent Agent to identify targets
  console.log("-> Running Intent Agent...");
  const intentOutput = await intentAgentNode(state);
  console.log(`Result Status: ${intentOutput.status}`);
  console.log(`Target Files: ${intentOutput.targetFiles.join(', ')}`);

  state = {
    ...state,
    status: intentOutput.status,
    targetFiles: intentOutput.targetFiles
  };

  // 3. Run Context Retrieval Agent (Graphify Engine + ASTParser)
  console.log("\n-> Running Context Retrieval Agent (Graphify Engine)...");
  const retrievalOutput = await contextRetrievalAgentNode(state);
  console.log(`Context Retrieval Status: ${retrievalOutput.status}`);

  state = {
    ...state,
    extractedContext: retrievalOutput.extractedContext,
    targetFiles: retrievalOutput.targetFiles
  };

  // 4. Conditional Routing
  if (state.status === "ROUTED_EXPLAIN_CODE") {
    console.log("\n[Route: Explain Code] Skipping planning and generation.");
    console.log("Explanation logic triggered for context:");
    console.log(state.extractedContext || "(No code context to explain)");
    return;
  }

  if (state.status === "ROUTED_GENERATE_CODE" || state.status === "ROUTED_REFACTOR") {
    console.log("\n-> Running Planner Agent...");
    const plannerOutput = await plannerAgentNode(state);
    console.log(`Planner Status: ${plannerOutput.status}`);
    console.log("Steps:");
    plannerOutput.plan?.forEach(step => {
      console.log(`- Step ${step.id} [${step.status}]: ${step.description}`);
    });

    state = {
      ...state,
      plan: plannerOutput.plan || [],
      status: plannerOutput.status || "PLANNED"
    };

    console.log("\n-> Running Coder Agent...");
    const coderOutput = await codeGenAgentNode(state);
    console.log(`Coder Status: ${coderOutput.status}`);
    console.log("\nExtracted Context (including generated code):");
    console.log(coderOutput.extractedContext);

    // 5. Write all clean generated file patches back to disk
    if (coderOutput.filePatches && coderOutput.filePatches.length > 0) {
      for (const patch of coderOutput.filePatches) {
        if (!isProtectedFile(patch.filePath)) {
          try {
            const dir = path.dirname(patch.filePath);
            if (!fs.existsSync(dir)) {
              fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(patch.filePath, patch.code, 'utf-8');
            console.log(`\nSuccess! Saved code changes to: ${patch.filePath}`);
          } catch (err) {
            console.error(`Failed to write file ${patch.filePath}:`, err);
          }
        } else {
          console.warn(`Skipped writing to protected file: ${patch.filePath}`);
        }
      }
    } else if (coderOutput.generatedPatch && state.targetFiles[0]) {
      const targetFile = state.targetFiles[0];
      if (!isProtectedFile(targetFile)) {
        try {
          const dir = path.dirname(targetFile);
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
          }
          fs.writeFileSync(targetFile, coderOutput.generatedPatch, 'utf-8');
          console.log(`\nSuccess! Saved code changes to: ${targetFile}`);
        } catch (err) {
          console.error(`Failed to write file ${targetFile}:`, err);
        }
      }
    }

    return;
  }

  if (state.status === "ROUTED_DEBUG_ERROR") {
    console.log("\n[Route: Debug Error] Initiating error resolution flow.");
    console.log("Analyzing user report and context...");
    return;
  }

  console.log(`Unknown routed status: ${state.status}`);
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

runDemo().catch(err => {
  console.error("Pipeline run failed:", err);
});
