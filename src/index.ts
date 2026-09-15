import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { KaizenStateType } from './state';
import { intentAgentNode } from './agents/intentAgent';
import { contextRetrievalAgentNode } from './graph/agents/contextRetrievalAgent';
import { plannerAgentNode } from './agents/plannerAgent';
import { codeGenAgentNode, isProtectedFile } from './agents/codeGenAgent';
import { reviewerAgentNode } from './agents/reviewerAgent';
import { debuggerAgentNode } from './agents/debuggerAgent';

function promptUserApproval(questionText: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question(questionText, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

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

    // Human-in-the-Loop (HITL) Approval Step
    console.log("\n=========================================");
    console.log("HUMAN-IN-THE-LOOP (HITL): PLAN APPROVAL");
    console.log("=========================================");
    const answer = await promptUserApproval(
      "Do you approve this plan to proceed with code generation? [Y/n or enter feedback]: "
    );

    const lowerAns = answer.toLowerCase();
    if (lowerAns === 'n' || lowerAns === 'no' || lowerAns === 'cancel' || lowerAns === 'reject') {
      console.log("\n[HITL] Plan rejected by user. Aborting code generation.");
      return;
    }

    if (lowerAns !== 'y' && lowerAns !== 'yes' && lowerAns !== 'approve' && lowerAns !== '') {
      console.log(`\n[HITL] User provided feedback: "${answer}"`);
      console.log("-> Re-running Planner Agent with feedback...");
      state.userInput = `${state.userInput} (User plan feedback: ${answer})`;
      const updatedPlannerOutput = await plannerAgentNode(state);
      console.log(`Updated Planner Status: ${updatedPlannerOutput.status}`);
      console.log("Updated Steps:");
      updatedPlannerOutput.plan?.forEach(step => {
        console.log(`- Step ${step.id} [${step.status}]: ${step.description}`);
      });
      state.plan = updatedPlannerOutput.plan || state.plan;

      const confirmAns = await promptUserApproval("\nApprove updated plan? [Y/n]: ");
      if (confirmAns.toLowerCase() === 'n' || confirmAns.toLowerCase() === 'no') {
        console.log("\n[HITL] Updated plan rejected by user. Aborting code generation.");
        return;
      }
    }

    console.log("\n[HITL] Plan approved! Proceeding to code generation...");

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

    // 6. Run Code Reviewer Agent
    const reviewResult = await reviewerAgentNode({
      ...state,
      extractedContext: coderOutput.extractedContext || state.extractedContext
    });

    if (!reviewResult.approved) {
      console.log("\n[ReviewerAgent Notice]: Code patch requires revision based on review feedback.");
    }

    return;
  }

  if (state.status === "ROUTED_DEBUG_ERROR") {
    console.log("\n[Route: Debug Error] Initiating automated bug diagnosis flow.");
    const debugResult = await debuggerAgentNode(state);

    if (debugResult.filePatches && debugResult.filePatches.length > 0) {
      for (const patch of debugResult.filePatches) {
        if (!isProtectedFile(patch.filePath)) {
          try {
            const dir = path.dirname(patch.filePath);
            if (!fs.existsSync(dir)) {
              fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(patch.filePath, patch.code, 'utf-8');
            console.log(`\nSuccess! Saved bug fix changes to: ${patch.filePath}`);
          } catch (err) {
            console.error(`Failed to write file ${patch.filePath}:`, err);
          }
        }
      }
    }
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
