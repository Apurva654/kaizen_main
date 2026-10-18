import {
  intentAgentNode,
  isGitQuery,
  extractGitActions,
  isTerminalQuery,
  extractTerminalCommand,
  isBrowserQuery,
  extractBrowserUrl,
  isDeleteQuery,
  isGeneralQuery,
  isAmbiguousQuery,
  extractTargetFilesFromPrompt,
  IntentSchema
} from '../src/agents/intentAgent';
import { KaizenState } from '../src/state';

async function runIntentAgentTestSuite() {
  console.log('🧪 ========================================================');
  console.log('🧪 KAIZEN AI - IntentAgent Hardening Regression Test Suite');
  console.log('🧪 ========================================================\n');

  let passedTests = 0;
  let totalTests = 0;

  function assert(condition: boolean, testName: string, details?: string) {
    totalTests++;
    if (condition) {
      passedTests++;
      console.log(`  ✅ PASS: ${testName}`);
    } else {
      console.error(`  ❌ FAIL: ${testName} ${details ? '(' + details + ')' : ''}`);
      throw new Error(`Test assertion failed: ${testName}`);
    }
  }

  const createState = (userInput: string, targetFiles: string[] = []): any => ({
    userInput,
    targetFiles,
    plan: [],
    choices: [],
    filePatches: [],
    retryCount: 0,
    status: 'INITIALIZED'
  });

  // 1. Scenario 1: Fix a bug in src/agents/intentAgent.ts
  console.log('\n--- Scenario 1: Bug fix in specific file ---');
  const res1 = await intentAgentNode(createState('Fix a bug in src/agents/intentAgent.ts where null pointer error is thrown'));
  assert(res1.status === 'ROUTED_DEBUG_ERROR' || res1.status === 'ROUTED_GENERATE_CODE', 'Routes to DEBUG_ERROR or GENERATE_CODE');
  assert(res1.targetFiles.some(f => f.includes('intentAgent.ts')), 'Target files include intentAgent.ts');

  // 2. Scenario 2: Explain how intentAgent.ts works
  console.log('\n--- Scenario 2: Explain codebase code ---');
  const res2 = await intentAgentNode(createState('Explain how src/agents/intentAgent.ts works and its architecture'));
  assert(res2.status === 'ROUTED_EXPLAIN_CODE', 'Routes to EXPLAIN_CODE', `Received ${res2.status}`);
  assert(res2.targetFiles.some(f => f.includes('intentAgent.ts')), 'Target files include intentAgent.ts');

  // 3. Scenario 3: Refactor a specifically named source file
  console.log('\n--- Scenario 3: Refactor specific file ---');
  const res3 = await intentAgentNode(createState('Refactor src/sandbox/calculator.ts to optimize performance'));
  assert(res3.status === 'ROUTED_REFACTOR', 'Routes to REFACTOR', `Received ${res3.status}`);
  assert(res3.targetFiles.some(f => f.includes('calculator.ts')), 'Target files include calculator.ts');

  // 4. Scenario 4: Run the existing test suite
  console.log('\n--- Scenario 4: Run existing test suite ---');
  const res4 = await intentAgentNode(createState('Run the existing test suite to verify test passes'));
  assert(res4.status === 'ROUTED_RUN_EXISTING_TESTS', 'Routes to RUN_EXISTING_TESTS', `Received ${res4.status}`);

  // 5. Scenario 5: Perform a Git status request
  console.log('\n--- Scenario 5: Git status execution request ---');
  const res5 = await intentAgentNode(createState('git status and show changes'));
  assert(res5.status === 'ROUTED_MCP_GIT', 'Routes to MCP_GIT', `Received ${res5.status}`);
  const actions5 = extractGitActions('git status and show changes');
  assert(actions5.includes('status'), 'Extracts status git action');

  // 6. Scenario 6: Open an explicitly supplied URL
  console.log('\n--- Scenario 6: Open explicitly supplied URL ---');
  const res6 = await intentAgentNode(createState('Open http://localhost:3000/sandbox/index.html and check the layout'));
  assert(res6.status === 'ROUTED_MCP_BROWSER', 'Routes to MCP_BROWSER', `Received ${res6.status}`);
  const url6 = extractBrowserUrl('Open http://localhost:3000/sandbox/index.html and check the layout');
  assert(url6 === 'http://localhost:3000/sandbox/index.html', 'Extracts exact URL');

  // 7. Scenario 7: Delete a specified file
  console.log('\n--- Scenario 7: Delete specified file ---');
  const res7 = await intentAgentNode(createState('Delete the file src/sandbox/old_file.ts'));
  assert(res7.status === 'ROUTED_DELETE_FILES', 'Routes to DELETE_FILES', `Received ${res7.status}`);

  // 8. Scenario 8: Save a memory
  console.log('\n--- Scenario 8: Save memory preference ---');
  const res8 = await intentAgentNode(createState('Remember that our coding convention is TypeScript strict mode'));
  assert(res8.status === 'ROUTED_MEMORY_WRITE', 'Routes to MEMORY_WRITE', `Received ${res8.status}`);

  // 9. Scenario 9: Read existing memory
  console.log('\n--- Scenario 9: Read existing memory ---');
  const res9 = await intentAgentNode(createState('What project conventions do you remember?'));
  assert(res9.status === 'ROUTED_MEMORY_READ', 'Routes to MEMORY_READ', `Received ${res9.status}`);

  // 10. Scenario 10: Answer "What is a binary search tree?"
  console.log('\n--- Scenario 10: Conceptual query (BST) ---');
  const res10 = await intentAgentNode(createState('What is a binary search tree?'));
  assert(res10.status === 'ROUTED_GENERAL_QUERY', 'Routes to GENERAL_QUERY', `Received ${res10.status}`);
  assert(res10.targetFiles.length === 0, 'Target files is empty for general query');

  // 11. Scenario 11: Handle "Fix it" with no context
  console.log('\n--- Scenario 11: Vague "Fix it" prompt with no context ---');
  const res11 = await intentAgentNode(createState('Fix it'));
  assert(res11.status === 'ROUTED_GENERAL_QUERY', 'Routes to GENERAL_QUERY for clarification', `Received ${res11.status}`);
  assert(res11.targetFiles.length === 0, 'Target files is empty');

  // 12. Scenario 12: Explain what git status does without executing Git
  console.log('\n--- Scenario 12: Explain what git status does ---');
  assert(!isGitQuery('What does git status do?'), 'isGitQuery returns false for inquiry');
  assert(!isGitQuery('Explain what git status does'), 'isGitQuery returns false for explanation');
  const res12 = await intentAgentNode(createState('What does git status do?'));
  assert(res12.status === 'ROUTED_GENERAL_QUERY' || res12.status === 'ROUTED_EXPLAIN_CODE', 'Routes to GENERAL_QUERY or EXPLAIN_CODE', `Received ${res12.status}`);
  assert(res12.status !== 'ROUTED_MCP_GIT', 'Does NOT route to MCP_GIT');

  // 13. Scenario 13: Compound request: browser inspection + code change + tests
  console.log('\n--- Scenario 13: Compound request (open page and fix button) ---');
  assert(!isBrowserQuery('Open index.html and fix the broken button'), 'isBrowserQuery returns false when code fix requested');
  const res13 = await intentAgentNode(createState('Open index.html and fix the broken button'));
  assert(res13.status === 'ROUTED_DEBUG_ERROR' || res13.status === 'ROUTED_GENERATE_CODE', 'Prioritizes code fix over read-only browser', `Received ${res13.status}`);
  assert(res13.targetFiles.some(f => f.includes('index.html')), 'Extracts index.html as target file');

  // 14. Scenario 14: Confirm sandbox path-normalization behaviour remains unchanged
  console.log('\n--- Scenario 14: Sandbox path-normalization preservation ---');
  const p1 = extractTargetFilesFromPrompt('Create calculator.ts');
  assert(p1.includes('src/sandbox/calculator.ts'), 'Bare filename prefixed with src/sandbox/');
  const p2 = extractTargetFilesFromPrompt('Update src/utils.ts');
  assert(p2.includes('src/sandbox/utils.ts'), 'src/ path re-mapped to src/sandbox/');
  const p3 = extractTargetFilesFromPrompt('Edit src/sandbox/main.ts');
  assert(p3.includes('src/sandbox/main.ts'), 'src/sandbox/ path preserved cleanly');

  // 15. Scenario 15: Code deletion vs file deletion
  console.log('\n--- Scenario 15: Code deletion vs file deletion ---');
  assert(!isDeleteQuery('Delete the unused import from intentAgent.ts'), 'isDeleteQuery returns false for unused import');
  assert(!isDeleteQuery('Remove console.log from server.ts'), 'isDeleteQuery returns false for removing console.log');
  const res15 = await intentAgentNode(createState('Delete the unused import from intentAgent.ts'));
  assert(res15.status !== 'ROUTED_DELETE_FILES', 'Does NOT route to DELETE_FILES', `Received ${res15.status}`);
  assert(res15.status === 'ROUTED_REFACTOR' || res15.status === 'ROUTED_GENERATE_CODE', 'Routes to REFACTOR or GENERATE_CODE');

  // 16. Scenario 16: Handle malformed Gemini output safely
  console.log('\n--- Scenario 16: Malformed Gemini output schema validation ---');
  const invalidResult1 = { intent: 'NON_EXISTENT_INTENT_123' };
  const parseResult1 = IntentSchema.safeParse(invalidResult1);
  assert(!parseResult1.success, 'Schema safely rejects invalid intent string');
  const invalidResult2 = { intent: 42 };
  const parseResult2 = IntentSchema.safeParse(invalidResult2);
  assert(!parseResult2.success, 'Schema safely rejects non-string intent');

  // 17. Scenario 17: Handle missing API key or model failure gracefully
  console.log('\n--- Scenario 17: Fallback when API key is missing/unconfigured ---');
  const originalKey = process.env.GEMINI_API_KEY;
  try {
    delete process.env.GEMINI_API_KEY;
    const res17 = await intentAgentNode(createState('Refactor src/sandbox/helper.ts to clean up code'));
    assert(res17.status === 'ROUTED_REFACTOR', 'Graceful fallback routes to REFACTOR', `Received ${res17.status}`);
  } finally {
    process.env.GEMINI_API_KEY = originalKey;
  }

  // 18. Scenario 18: Unfamiliar prompt without defaulting to GENERATE_CODE
  console.log('\n--- Scenario 18: Unfamiliar prompt fallback ---');
  const originalKey18 = process.env.GEMINI_API_KEY;
  try {
    delete process.env.GEMINI_API_KEY;
    const res18 = await intentAgentNode(createState('asdfghjkl random gibberish prompt qwerty'));
    assert(res18.status === 'ROUTED_GENERAL_QUERY', 'Does NOT default unfamiliar prompt to GENERATE_CODE', `Received ${res18.status}`);
    assert(res18.targetFiles.length === 0, 'Target files is empty for unfamiliar prompt');
  } finally {
    process.env.GEMINI_API_KEY = originalKey18;
  }

  // 19. Scenario 19: Distinguish command-writing requests from execution requests
  console.log('\n--- Scenario 19: Command-writing vs execution requests ---');
  assert(!isTerminalQuery('Give me a command to list files'), 'isTerminalQuery returns false for suggestion query');
  assert(extractTerminalCommand('Give me a command to list files') === '', 'extractTerminalCommand returns empty string');
  const res19 = await intentAgentNode(createState('Give me a command to list files'));
  assert(res19.status === 'ROUTED_GENERAL_QUERY' || res19.status === 'ROUTED_EXPLAIN_CODE', 'Routes to GENERAL_QUERY/EXPLAIN_CODE', `Received ${res19.status}`);
  assert(res19.status !== 'ROUTED_MCP_TERMINAL', 'Does NOT route to MCP_TERMINAL');

  // 20. Scenario 20: Inferred browser URLs without claiming navigation succeeded
  console.log('\n--- Scenario 20: Inferred browser URL extraction ---');
  const url20 = extractBrowserUrl('preview the landing page');
  assert(typeof url20 === 'string' && url20.startsWith('http://'), 'Returns valid HTTP URL string');
  assert(url20.includes('3000'), 'URL points to local server port');

  console.log('\n========================================================');
  console.log(`🎉 ALL 20 INTENT SCENARIOS VERIFIED: ${passedTests}/${totalTests} checks passed`);
  console.log('========================================================\n');
}

runIntentAgentTestSuite().catch((err) => {
  console.error('Test suite failed with error:', err);
  process.exit(1);
});
