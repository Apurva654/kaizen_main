import { KaizenStateType } from './state';
import { intentAgentNode } from './agents/intentAgent';
import { plannerAgentNode } from './agents/plannerAgent';
import { codeGenAgentNode } from './agents/codeGenAgent';

async function executeAgentPipeline(userInput: string, targetFiles: string[], context: string) {
  console.log(`\n=========================================`);
  console.log(`User Input: "${userInput}"`);
  console.log(`=========================================`);

  let state: KaizenStateType = {
    userInput,
    targetFiles,
    extractedContext: context,
    plan: [],
    generatedPatch: "",
    choices: [],
    retryCount: 0,
    status: "INITIALIZED"
  };

  console.log("-> Running Intent Agent...");
  const intentOutput = await intentAgentNode(state);
  console.log(`Result Status: ${intentOutput.status}`);
  console.log(`Target Files: ${intentOutput.targetFiles.join(', ')}`);

  state = {
    ...state,
    status: intentOutput.status,
    targetFiles: intentOutput.targetFiles
  };

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

  if (cliQuery) {
    console.log("=== KAIZEN RUNNING CUSTOM QUERY ===");
    await executeAgentPipeline(
      cliQuery,
      ["src/mathUtils.ts"],
      "export function multiply(a: number, b: number) { return a * b; }"
    );
  } else {
    console.log("=== KAIZEN MULTI-AGENT ROUTER DEMO ===");

    await executeAgentPipeline(
      "Create a simple math utility function that adds two numbers together.",
      ["src/mathUtils.ts"],
      "export function multiply(a: number, b: number) { return a * b; }"
    );

    await executeAgentPipeline(
      "samjha do how this multiply function works",
      ["src/mathUtils.ts"],
      "export function multiply(a: number, b: number) { return a * b; }"
    );
  }
}

runDemo().catch(err => {
  console.error("Pipeline run failed:", err);
});
