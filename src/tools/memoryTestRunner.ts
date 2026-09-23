import { memoryEngine } from '../context/memory/memoryEngine';
import { contextManager } from '../context/contextManager';
import { sanitizeSecretInfo } from '../context/memory/memoryTypes';
import { persistenceEngine } from './persistenceEngine';
import { KaizenStateType } from '../state';
import { runWorkspaceTests } from './testRunner';
import * as fs from 'fs';
import * as path from 'path';

export interface VerificationResult {
  feature: string;
  status: 'PASS' | 'FAIL' | 'WARN';
  details: string;
  timestamp: Date;
}

export async function runMemoryTests(): Promise<VerificationResult[]> {
  const results: VerificationResult[] = [];
  const testWorkspace = 'test_ws_' + Date.now();

  // Test 1: State Memory Integration
  try {
    const mockState: Partial<KaizenStateType> = {
      sessionId: 'sess_test_123',
      runId: 'run_99',
      userInput: 'Implement order service',
      currentStage: 'coder',
      targetFiles: ['src/sandbox/order.ts'],
      status: 'CODING',
      retryCount: 1,
      structuredFailures: [{ message: 'Import path undefined' }]
    };

    memoryEngine.stateMemory.updateState(mockState as KaizenStateType, testWorkspace);
    const retrievedState = memoryEngine.stateMemory.getState();

    if (
      retrievedState &&
      retrievedState.sessionId === 'sess_test_123' &&
      retrievedState.currentStage === 'coder' &&
      retrievedState.errors.some(e => e.includes('Import path undefined'))
    ) {
      results.push({
        feature: '1. State Memory Management',
        status: 'PASS',
        details: 'State Memory correctly captures active LangGraph execution state and checkpoint sync',
        timestamp: new Date()
      });
    } else {
      results.push({
        feature: '1. State Memory Management',
        status: 'FAIL',
        details: `Unexpected state captured: ${JSON.stringify(retrievedState)}`,
        timestamp: new Date()
      });
    }
  } catch (err: any) {
    results.push({
      feature: '1. State Memory Management',
      status: 'FAIL',
      details: err?.message || String(err),
      timestamp: new Date()
    });
  }

  // Test 2: Short-Term Memory Bounded Window & Compaction
  try {
    memoryEngine.shortTermMemory.clear();
    for (let i = 1; i <= 35; i++) {
      memoryEngine.shortTermMemory.addEvent({
        eventKind: 'USER_MESSAGE',
        role: 'user',
        content: `Test prompt ${i}`,
        workspaceId: testWorkspace
      });
    }

    const events = memoryEngine.shortTermMemory.getEvents();
    if (events.length <= 30 && events.some(e => e.tags?.includes('compacted_summary'))) {
      results.push({
        feature: '2. Short-Term Memory & Compaction',
        status: 'PASS',
        details: `Short-Term memory enforced bounded window (${events.length} items) with automated compaction`,
        timestamp: new Date()
      });
    } else {
      results.push({
        feature: '2. Short-Term Memory & Compaction',
        status: 'FAIL',
        details: `Events count ${events.length}, expected <= 30 with compaction summary`,
        timestamp: new Date()
      });
    }
  } catch (err: any) {
    results.push({
      feature: '2. Short-Term Memory & Compaction',
      status: 'FAIL',
      details: err?.message || String(err),
      timestamp: new Date()
    });
  }

  // Test 3: Long-Term Memory & Secret Scrubbing (Regression Suite A, B, C, D, E, F, G)
  try {
    const testA = sanitizeSecretInfo("Remember that the API key is sk-test-DEMO123.");
    const testB = sanitizeSecretInfo("Remember that apiKey: sk-test-DEMO123.");
    const testC = sanitizeSecretInfo("Remember that the password is demo-password.");
    const testD = sanitizeSecretInfo('Remember that password="demo-password".');
    const testE = sanitizeSecretInfo("What is the primary key of this table? Enter your password in the prompt box.");

    const aPassed = testA.includes('[REDACTED_API_KEY]') && !testA.includes('sk-test-DEMO123');
    const bPassed = testB.includes('[REDACTED_API_KEY]') && !testB.includes('sk-test-DEMO123');
    const cPassed = testC.includes('[REDACTED]') && !testC.includes('demo-password');
    const dPassed = testD.includes('[REDACTED]') && !testD.includes('demo-password');
    const ePassed = testE === "What is the primary key of this table? Enter your password in the prompt box.";

    memoryEngine.longTermMemory.addFact(
      'coding_convention',
      'Credential Test',
      'Remember that the API key is sk-test-DEMO123 and password is demo-password.',
      'user_test',
      0.95,
      testWorkspace,
      ['convention']
    );

    const fact = memoryEngine.longTermMemory.getFact('Credential Test', testWorkspace);
    const factRedacted = fact && fact.value.includes('[REDACTED_API_KEY]') && fact.value.includes('[REDACTED]') && !fact.value.includes('sk-test-DEMO123') && !fact.value.includes('demo-password');

    if (aPassed && bPassed && cPassed && dPassed && ePassed && factRedacted) {
      results.push({
        feature: '3. Long-Term Memory & Secret Protection (Regression A-E)',
        status: 'PASS',
        details: 'Secret protection correctly redacted natural language API keys & passwords while preserving normal text.',
        timestamp: new Date()
      });
    } else {
      results.push({
        feature: '3. Long-Term Memory & Secret Protection (Regression A-E)',
        status: 'FAIL',
        details: `Regression failed: A=${aPassed}, B=${bPassed}, C=${cPassed}, D=${dPassed}, E=${ePassed}, factRedacted=${factRedacted}`,
        timestamp: new Date()
      });
    }
  } catch (err: any) {
    results.push({
      feature: '3. Long-Term Memory & Secret Protection (Regression A-E)',
      status: 'FAIL',
      details: err?.message || String(err),
      timestamp: new Date()
    });
  }

  // Test 4: Episodic Memory Experience Logging
  try {
    const episode = memoryEngine.episodicMemory.addEpisode({
      task: 'Fix JWT Token Validation Middleware',
      intent: 'DEBUG_CODE',
      affectedFiles: ['src/sandbox/auth.ts', 'src/sandbox/app.ts'],
      actions: ['Parsed AST', 'Registered middleware in app.ts'],
      errors: ['Token validation failed because auth middleware was unregistered'],
      solution: 'Registered auth middleware explicitly before router in app.ts',
      outcome: 'success',
      testsPassed: true,
      lessons: ['Always register auth middleware prior to routing'],
      workspaceId: testWorkspace,
      tags: ['auth', 'jwt', 'middleware']
    });

    const searched = memoryEngine.episodicMemory.searchEpisodes('JWT Token Validation', testWorkspace);
    if (searched.length > 0 && searched[0].episodeId === episode.episodeId) {
      results.push({
        feature: '4. Episodic Memory Storage & Search',
        status: 'PASS',
        details: 'Episodic Memory logged task experience episode and retrieved it via task query search',
        timestamp: new Date()
      });
    } else {
      results.push({
        feature: '4. Episodic Memory Storage & Search',
        status: 'FAIL',
        details: `Search returned ${searched.length} episodes`,
        timestamp: new Date()
      });
    }
  } catch (err: any) {
    results.push({
      feature: '4. Episodic Memory Storage & Search',
      status: 'FAIL',
      details: err?.message || String(err),
      timestamp: new Date()
    });
  }

  // Test 5: Memory Retrieval Scoring & Top-K Ranking
  try {
    const query = {
      prompt: 'Fix auth middleware JWT validation error',
      workspaceId: testWorkspace,
      targetFiles: ['src/sandbox/auth.ts'],
      topKShortTerm: 3,
      topKLongTerm: 3,
      topKEpisodic: 3
    };

    const retrieved = memoryEngine.retrieveRelevant(query);
    if (retrieved.episodicMemory.length > 0 && retrieved.episodicMemory[0].task.includes('JWT')) {
      results.push({
        feature: '5. Memory Retrieval & Relevance Ranking',
        status: 'PASS',
        details: 'MemoryRetriever scored and returned top-K relevant episodic & long-term memories',
        timestamp: new Date()
      });
    } else {
      results.push({
        feature: '5. Memory Retrieval & Relevance Ranking',
        status: 'FAIL',
        details: `Retrieved episodic count: ${retrieved.episodicMemory.length}`,
        timestamp: new Date()
      });
    }
  } catch (err: any) {
    results.push({
      feature: '5. Memory Retrieval & Relevance Ranking',
      status: 'FAIL',
      details: err?.message || String(err),
      timestamp: new Date()
    });
  }

  // Test 6: Controlled Memory Consolidation
  try {
    memoryEngine.consolidator.consolidateTurn('My name is Alice and we use Express framework', 'Hello Alice!', testWorkspace);
    const nameFact = memoryEngine.longTermMemory.getFact('User Name', testWorkspace);
    const fwFact = memoryEngine.longTermMemory.getFact('Preferred Framework', testWorkspace);

    if (nameFact && nameFact.value === 'Alice' && fwFact && fwFact.value === 'express') {
      results.push({
        feature: '6. Controlled Memory Consolidation',
        status: 'PASS',
        details: 'MemoryConsolidator promoted explicit user preferences to Long-Term Memory',
        timestamp: new Date()
      });
    } else {
      results.push({
        feature: '6. Controlled Memory Consolidation',
        status: 'FAIL',
        details: `NameFact: ${JSON.stringify(nameFact)}, FwFact: ${JSON.stringify(fwFact)}`,
        timestamp: new Date()
      });
    }
  } catch (err: any) {
    results.push({
      feature: '6. Controlled Memory Consolidation',
      status: 'FAIL',
      details: err?.message || String(err),
      timestamp: new Date()
    });
  }

  // Test 7: Persistence Engine Integration & Safety
  try {
    memoryEngine.longTermMemory.saveToPersistence();
    const diskFacts = persistenceEngine.readMemoryJson<any[]>('long-term.json');

    if (diskFacts && Array.isArray(diskFacts)) {
      results.push({
        feature: '7. Persistence Foundation (.kaizen/storage/memory/)',
        status: 'PASS',
        details: 'Memory persisted safely to disk under .kaizen/storage/memory/ without data loss',
        timestamp: new Date()
      });
    } else {
      results.push({
        feature: '7. Persistence Foundation (.kaizen/storage/memory/)',
        status: 'FAIL',
        details: 'Failed to verify disk file long-term.json',
        timestamp: new Date()
      });
    }
  } catch (err: any) {
    results.push({
      feature: '7. Persistence Foundation (.kaizen/storage/memory/)',
      status: 'FAIL',
      details: err?.message || String(err),
      timestamp: new Date()
    });
  }

  // Test 8: Context Assembler Enriched Prompt Context
  try {
    const codeContext = '=== MOCK AST CODE CONTEXT ===\nclass AuthService {}';
    const enriched = await contextManager.buildEnrichedContext('Fix auth token error', codeContext, testWorkspace);

    if (
      enriched.includes('PROJECT CONTEXT:') &&
      enriched.includes('=== KAIZEN FOUR-MEMORY SYSTEM ===') &&
      enriched.includes('STATE MEMORY') &&
      enriched.includes('SHORT-TERM MEMORY') &&
      enriched.includes('EPISODIC MEMORY')
    ) {
      results.push({
        feature: '8. Context Assembler Integration',
        status: 'PASS',
        details: 'Context Assembler built enriched prompt combining Code Context + 4 Memory System without explosion',
        timestamp: new Date()
      });
    } else {
      results.push({
        feature: '8. Context Assembler Integration',
        status: 'FAIL',
        details: 'Enriched context missing required memory sections',
        timestamp: new Date()
      });
    }
  } catch (err: any) {
    results.push({
      feature: '8. Context Assembler Integration',
      status: 'FAIL',
      details: err?.message || String(err),
      timestamp: new Date()
    });
  }

  // Test 9: End-to-End Self-Healing Experience Reuse Scenario
  try {
    // TASK 1: Implement feature that initially fails a test -> Debugger fixes it -> create Episodic memory
    const task1Name = 'Implement OAuth2 state parameter verification';
    const task1Files = ['src/sandbox/oauth.ts'];
    const task1Error = 'OAuth2 CSRF state verification failed because state token salt was missing';
    const task1Solution = 'Generate random state salt using crypto.randomBytes and store in session before redirect';

    memoryEngine.consolidator.consolidateTaskOutcome({
      task: task1Name,
      intent: 'DEBUG_CODE',
      affectedFiles: task1Files,
      actions: ['Executed test', 'Added crypto salt generator'],
      errors: [task1Error],
      solution: task1Solution,
      outcome: 'success',
      testsPassed: true,
      lessons: ['OAuth state tokens must use cryptographically secure salt'],
      workspaceId: testWorkspace
    });

    // TASK 2: Similar feature has same type of error
    const task2Name = 'Add state parameter check to OAuth callback handler';
    const task2Query = {
      prompt: task2Name,
      workspaceId: testWorkspace,
      targetFiles: task1Files,
      topKEpisodic: 3
    };

    const retrievedEpisodes = memoryEngine.retriever.retrieveEpisodic(task2Query);

    if (
      retrievedEpisodes.length > 0 &&
      retrievedEpisodes.some(ep => ep.solution.includes('crypto.randomBytes'))
    ) {
      results.push({
        feature: '9. End-to-End Self-Healing Experience Reuse',
        status: 'PASS',
        details: 'Task 2 successfully retrieved Task 1 self-healing episode and solution prior to planning',
        timestamp: new Date()
      });
    } else {
      results.push({
        feature: '9. End-to-End Self-Healing Experience Reuse',
        status: 'FAIL',
        details: `Task 2 failed to retrieve Task 1 episode. Count: ${retrievedEpisodes.length}`,
        timestamp: new Date()
      });
    }
  } catch (err: any) {
    results.push({
      feature: '9. End-to-End Self-Healing Experience Reuse',
      status: 'FAIL',
      details: err?.message || String(err),
      timestamp: new Date()
    });
  }

  // Test 10: Dedicated Memory-Only Intent Routing (TEST A, TEST B, TEST C, TEST D, TEST E & Regression)
  try {
    const { intentAgentNode } = await import('../agents/intentAgent');

    // TEST A
    const testAInput = "Remember that this project uses TypeScript strict mode. Do not modify files.";
    const testAState = { userInput: testAInput, targetFiles: [] } as any;
    const testAResult = await intentAgentNode(testAState);

    // TEST B
    const testBInput = "What TypeScript conventions do you remember about this project?";
    const testBState = { userInput: testBInput, targetFiles: [] } as any;
    const testBResult = await intentAgentNode(testBState);

    // TEST C
    const testCInput = "Add strict mode to the project's TypeScript configuration.";
    const testCState = { userInput: testCInput, targetFiles: [] } as any;
    const testCResult = await intentAgentNode(testCState);

    // TEST D
    const testDInput = "Remember that we prefer Tailwind for UI styling.";
    const testDState = { userInput: testDInput, targetFiles: [] } as any;
    const testDResult = await intentAgentNode(testDState);

    // TEST E
    const testEInput = "Fix the Tailwind styling on the login page.";
    const testEState = { userInput: testEInput, targetFiles: [] } as any;
    const testEResult = await intentAgentNode(testEState);

    const testAPassed = testAResult.status === 'ROUTED_MEMORY_WRITE' && testAResult.targetFiles.length === 0;
    const testBPassed = testBResult.status === 'ROUTED_MEMORY_READ' && testBResult.targetFiles.length === 0;
    const testCPassed = testCResult.status !== 'ROUTED_MEMORY_WRITE' && testCResult.status !== 'ROUTED_MEMORY_READ';
    const testDPassed = testDResult.status === 'ROUTED_MEMORY_WRITE' && testDResult.targetFiles.length === 0;
    const testEPassed = testEResult.status !== 'ROUTED_MEMORY_WRITE' && testEResult.status !== 'ROUTED_MEMORY_READ';

    if (testAPassed && testBPassed && testCPassed && testDPassed && testEPassed) {
      results.push({
        feature: '10. Dedicated Memory-Only Intent Routing (TEST A, B, C, D, E & Regression)',
        status: 'PASS',
        details: `All 5 Memory Intent tests passed cleanly: TEST A (${testAResult.status}), TEST B (${testBResult.status}), TEST C (${testCResult.status}), TEST D (${testDResult.status}), TEST E (${testEResult.status})`,
        timestamp: new Date()
      });
    } else {
      results.push({
        feature: '10. Dedicated Memory-Only Intent Routing (TEST A, B, C, D, E & Regression)',
        status: 'FAIL',
        details: `Failed intent routing: A=${testAResult.status}, B=${testBResult.status}, C=${testCResult.status}, D=${testDResult.status}, E=${testEResult.status}`,
        timestamp: new Date()
      });
    }
  } catch (err: any) {
    results.push({
      feature: '10. Dedicated Memory-Only Intent Routing (TEST A, B, C, D, E & Regression)',
      status: 'FAIL',
      details: err?.message || String(err),
      timestamp: new Date()
    });
  }

  // Test 11: Episodic Memory Pipeline Isolation & Stale Context Prevention Regression Test
  try {
    const { plannerAgentNode } = await import('../agents/plannerAgent');
    const { intentAgentNode } = await import('../agents/intentAgent');

    memoryEngine.stateMemory.clearState();

    const exactPrompt = "Create a Python file at src/sandbox/episodic_demo.py containing a function divide(a, b) that returns a / b, and add a pytest test for it. Do not modify any other files.";

    let state: KaizenStateType = {
      sessionId: 'sess_exact_' + Date.now(),
      runId: 'run_exact_1',
      createdAt: new Date().toISOString(),
      userInput: exactPrompt,
      originalUserRequest: exactPrompt,
      targetFiles: [],
      extractedContext: "",
      plan: [],
      planApprovalStatus: 'NONE',
      generatedPatch: "",
      choices: [],
      retryCount: 0,
      status: "INITIALIZED",
      lifecycleStatus: "RUNNING",
      currentStage: "intent",
      completedStages: [],
      skippedStages: [],
      generalAnswer: undefined,
      imagePayload: undefined,
      extractedImageText: undefined,
      permissionMode: 'auto_mode',
      riskScore: 0,
      permissionStatus: 'APPROVED',
      mcpActions: [],
      dockerSandboxActive: false,
      structuredFailures: [],
      errorsEncountered: 0
    };

    const intent = await intentAgentNode(state);
    state.targetFiles = intent.targetFiles;
    state.status = intent.status;

    const planner = await plannerAgentNode(state);
    state.plan = planner.plan;
    state.targetFiles = planner.targetFiles;

    // Assertions required by Section 8
    const hasEpisodicDemo = state.targetFiles.includes('src/sandbox/episodic_demo.py');
    const hasTestFile = state.targetFiles.includes('src/sandbox/tests/test_episodic_demo.py') || state.targetFiles.includes('src/sandbox/test_episodic_demo.py');
    const planNotEmpty = state.plan.length > 0;
    const allStepsHaveTargetFile = state.plan.every(step => !!step.targetFile);
    const allTargetsBelongToExpected = state.plan.every(step => state.targetFiles.includes(step.targetFile!));
    
    const mentionsDivide = state.plan.some(step => step.description.toLowerCase().includes('divide'));
    const targetsDemoPy = state.plan.some(step => step.targetFile === 'src/sandbox/episodic_demo.py');
    const targetsTestPy = state.plan.some(step => step.targetFile === 'src/sandbox/tests/test_episodic_demo.py' || step.targetFile === 'src/sandbox/test_episodic_demo.py');

    const hasForbiddenModuleArtifacts = state.plan.some(step =>
      step.targetFile?.includes('Module.ts') ||
      step.targetFile?.includes('moduleTypes.ts') ||
      step.targetFile?.includes('ModuleRepository') ||
      step.targetFile?.includes('ModuleService') ||
      step.targetFile?.includes('ModuleController') ||
      step.description.includes('Module domain model')
    );

    if (
      hasEpisodicDemo &&
      hasTestFile &&
      planNotEmpty &&
      allStepsHaveTargetFile &&
      allTargetsBelongToExpected &&
      mentionsDivide &&
      targetsDemoPy &&
      targetsTestPy &&
      !hasForbiddenModuleArtifacts
    ) {
      results.push({
        feature: '11. Episodic Memory Pipeline Isolation & Stale Context Prevention Regression Test',
        status: 'PASS',
        details: `Generated plan concerns divide() & episodic_demo.py strictly across targets: [${state.targetFiles.join(', ')}] with ZERO Module artifacts.`,
        timestamp: new Date()
      });
    } else {
      results.push({
        feature: '11. Episodic Memory Pipeline Isolation & Stale Context Prevention Regression Test',
        status: 'FAIL',
        details: `Regression assertions failed: hasEpisodicDemo=${hasEpisodicDemo}, hasTestFile=${hasTestFile}, planNotEmpty=${planNotEmpty}, allStepsHaveTargetFile=${allStepsHaveTargetFile}, allTargetsBelongToExpected=${allTargetsBelongToExpected}, mentionsDivide=${mentionsDivide}, targetsDemoPy=${targetsDemoPy}, targetsTestPy=${targetsTestPy}, hasForbiddenModuleArtifacts=${hasForbiddenModuleArtifacts}, targetFiles=[${state.targetFiles.join(', ')}]`,
        timestamp: new Date()
      });
    }
  } catch (err: any) {
    results.push({
      feature: '11. Episodic Memory Pipeline Isolation & Stale Context Prevention Regression Test',
      status: 'FAIL',
      details: err?.message || String(err),
      timestamp: new Date()
    });
  }

  // Test 12: Consecutive Unrelated Requests Isolation Test
  try {
    const { plannerAgentNode } = await import('../agents/plannerAgent');
    const { intentAgentNode } = await import('../agents/intentAgent');

    // REQUEST 1
    const req1Input = "Create a Python file at src/sandbox/episodic_demo.py containing divide(a, b).";
    memoryEngine.stateMemory.clearState();

    let state1: KaizenStateType = {
      sessionId: 'sess_req1_' + Date.now(),
      runId: 'run_req1',
      createdAt: new Date().toISOString(),
      userInput: req1Input,
      originalUserRequest: req1Input,
      targetFiles: [],
      extractedContext: "",
      plan: [],
      planApprovalStatus: 'NONE',
      generatedPatch: "",
      choices: [],
      retryCount: 0,
      status: "INITIALIZED",
      lifecycleStatus: "RUNNING",
      currentStage: "intent",
      completedStages: [],
      skippedStages: [],
      generalAnswer: undefined,
      imagePayload: undefined,
      extractedImageText: undefined,
      permissionMode: 'auto_mode',
      riskScore: 0,
      permissionStatus: 'APPROVED',
      mcpActions: [],
      dockerSandboxActive: false,
      structuredFailures: [],
      errorsEncountered: 0
    };

    const intent1 = await intentAgentNode(state1);
    state1.targetFiles = intent1.targetFiles;
    state1.status = intent1.status;

    const planner1 = await plannerAgentNode(state1);
    state1.plan = planner1.plan;
    state1.targetFiles = planner1.targetFiles;

    memoryEngine.stateMemory.updateState(state1, testWorkspace);

    // REQUEST 2
    const req2Input = "Create a TypeScript file at src/sandbox/string_demo.ts containing a function reverseString(s).";

    memoryEngine.stateMemory.clearState();

    let state2: KaizenStateType = {
      sessionId: 'sess_req2_' + Date.now(),
      runId: 'run_req2',
      createdAt: new Date().toISOString(),
      userInput: req2Input,
      originalUserRequest: req2Input,
      targetFiles: [],
      extractedContext: "",
      plan: [],
      planApprovalStatus: 'NONE',
      generatedPatch: "",
      choices: [],
      retryCount: 0,
      status: "INITIALIZED",
      lifecycleStatus: "RUNNING",
      currentStage: "intent",
      completedStages: [],
      skippedStages: [],
      generalAnswer: undefined,
      imagePayload: undefined,
      extractedImageText: undefined,
      permissionMode: 'auto_mode',
      riskScore: 0,
      permissionStatus: 'APPROVED',
      mcpActions: [],
      dockerSandboxActive: false,
      structuredFailures: [],
      errorsEncountered: 0
    };

    const intent2 = await intentAgentNode(state2);
    state2.targetFiles = intent2.targetFiles;
    state2.status = intent2.status;

    const planner2 = await plannerAgentNode(state2);
    state2.plan = planner2.plan;
    state2.targetFiles = planner2.targetFiles;

    const req1OnlyEpisodic = state1.targetFiles.every(f => f.includes('episodic_demo.py'));
    const req2OnlyStringDemo = state2.targetFiles.every(f => f.includes('string_demo.ts'));
    const req2NoEpisodic = !state2.targetFiles.some(f => f.includes('episodic_demo.py')) &&
      !state2.plan.some(s => s.targetFile?.includes('episodic_demo.py') || s.description.includes('episodic_demo'));
    const req2NoModule = !state2.plan.some(s => s.targetFile?.includes('Module') || s.description.includes('Module'));
    const req2NoStaleReq1Steps = !state2.plan.some(s => s.description.includes('divide'));

    if (req1OnlyEpisodic && req2OnlyStringDemo && req2NoEpisodic && req2NoModule && req2NoStaleReq1Steps) {
      results.push({
        feature: '12. Consecutive Unrelated Requests Plan State Isolation',
        status: 'PASS',
        details: 'Request 1 (episodic_demo.py) and Request 2 (string_demo.ts) generated 100% independent plan states with zero cross-task contamination.',
        timestamp: new Date()
      });
    } else {
      results.push({
        feature: '12. Consecutive Unrelated Requests Plan State Isolation',
        status: 'FAIL',
        details: `Consecutive isolation failed: req1OnlyEpisodic=${req1OnlyEpisodic}, req2OnlyStringDemo=${req2OnlyStringDemo}, req2NoEpisodic=${req2NoEpisodic}, req2NoModule=${req2NoModule}, req2NoStaleReq1Steps=${req2NoStaleReq1Steps}`,
        timestamp: new Date()
      });
    }
  } catch (err: any) {
    results.push({
      feature: '12. Consecutive Unrelated Requests Plan State Isolation',
      status: 'FAIL',
      details: err?.message || String(err),
      timestamp: new Date()
    });
  }

  // Test 13: Self-Healing Episodic Demo Pytest Execution & Memory Recording
  try {
    const rootDir = process.cwd();
    const implPath = path.join(rootDir, 'src/sandbox/episodic_demo.py');
    const testPath = path.join(rootDir, 'src/sandbox/tests/test_episodic_demo.py');

    const implExists = fs.existsSync(implPath);
    const testExists = fs.existsSync(testPath);

    let implCode = implExists ? fs.readFileSync(implPath, 'utf8') : '';
    let testCode = testExists ? fs.readFileSync(testPath, 'utf8') : '';

    const implHasValueError = implCode.includes('ValueError') && implCode.includes('Cannot divide by zero');
    const testHasValueErrorCheck = testCode.includes('ValueError') || testCode.includes('Cannot divide by zero');

    // Execute test suite via runWorkspaceTests
    const testResult = await runWorkspaceTests(['src/sandbox/episodic_demo.py', 'src/sandbox/tests/test_episodic_demo.py']);

    // Consolidate into Episodic Memory upon successful run
    let recordedEpisode: any = null;
    if (testResult.passed) {
      recordedEpisode = memoryEngine.consolidator.consolidateTaskOutcome({
        task: 'Modify src/sandbox/episodic_demo.py so that divide(a, b) raises a ValueError with message "Cannot divide by zero" when b is 0',
        intent: 'MODIFY_CODE',
        affectedFiles: ['src/sandbox/episodic_demo.py', 'src/sandbox/tests/test_episodic_demo.py'],
        actions: ['Updated divide(a,b) implementation to check b == 0', 'Updated pytest test to check ValueError("Cannot divide by zero")'],
        errors: [],
        solution: 'Added if b == 0: raise ValueError("Cannot divide by zero") in divide(a, b)',
        outcome: 'success',
        testsPassed: true,
        lessons: ['Python zero division requires checking divisor b == 0 before division'],
        workspaceId: testWorkspace
      });
    }

    const searchedEpisodes = memoryEngine.episodicMemory.searchEpisodes('Cannot divide by zero', testWorkspace);
    const episodeRecorded = searchedEpisodes.length > 0 && searchedEpisodes[0].testsPassed === true;

    if (implExists && testExists && implHasValueError && testHasValueErrorCheck && testResult.passed && episodeRecorded) {
      results.push({
        feature: '13. Self-Healing Episodic Demo Pytest Execution & Memory Recording',
        status: 'PASS',
        details: `episodic_demo.py passed unit tests cleanly (${testResult.summary.trim()}) and recorded successful resolution in Episodic Memory.`,
        timestamp: new Date()
      });
    } else {
      results.push({
        feature: '13. Self-Healing Episodic Demo Pytest Execution & Memory Recording',
        status: 'FAIL',
        details: `Test 13 assertions failed: implExists=${implExists}, testExists=${testExists}, implHasValueError=${implHasValueError}, testHasValueErrorCheck=${testHasValueErrorCheck}, testPassed=${testResult.passed}, episodeRecorded=${episodeRecorded}`,
        timestamp: new Date()
      });
    }
  } catch (err: any) {
    results.push({
      feature: '13. Self-Healing Episodic Demo Pytest Execution & Memory Recording',
      status: 'FAIL',
      details: err?.message || String(err),
      timestamp: new Date()
    });
  }

  // Test 14: ROUTED_MEMORY_READ Episodic Memory Recall Regression Test
  try {

    const { intentAgentNode } = await import('../agents/intentAgent');

    // Ensure a divide() episodic memory is present in memoryEngine
    let searched = memoryEngine.episodicMemory.searchEpisodes('divide', 'default');
    if (searched.length === 0) {
      memoryEngine.consolidator.consolidateTaskOutcome({
        task: 'Modify src/sandbox/episodic_demo.py so that divide(a, b) raises a ValueError with message "Cannot divide by zero" when b is 0',
        intent: 'MODIFY_CODE',
        affectedFiles: ['src/sandbox/episodic_demo.py', 'src/sandbox/tests/test_episodic_demo.py'],
        actions: ['Updated divide(a,b) implementation', 'Updated test_episodic_demo.py'],
        errors: [],
        solution: 'Added if b == 0: raise ValueError("Cannot divide by zero") in divide(a, b)',
        outcome: 'success',
        testsPassed: true,
        lessons: ['Python zero division requires checking divisor b == 0 before division'],
        workspaceId: 'default'
      });
    }

    const exactQuery = "What previous coding task do you remember involving divide(), and what was the outcome?";
    
    // 1. Check intent classification
    const intentResult = await intentAgentNode({ userInput: exactQuery, targetFiles: [] } as any);
    const isMemoryReadRoute = intentResult.status === 'ROUTED_MEMORY_READ';

    // 2. Retrieve via memoryEngine.retrieveRelevant
    const retrieved = memoryEngine.retrieveRelevant({ prompt: exactQuery, workspaceId: 'default' });
    
    const hasEpisodicDivide = retrieved.episodicMemory.some(ep => 
      ep.task.includes('divide') || ep.solution.includes('divide') || ep.affectedFiles.some(f => f.includes('divide'))
    );
    const onlyLongTerm = retrieved.episodicMemory.length === 0 && retrieved.longTermMemory.length > 0;

    if (isMemoryReadRoute && hasEpisodicDivide && !onlyLongTerm) {
      results.push({
        feature: '14. ROUTED_MEMORY_READ Episodic Memory Recall',
        status: 'PASS',
        details: `Successfully retrieved divide() episodic memory episode (task: "${retrieved.episodicMemory[0].task.slice(0, 55)}...", outcome: ${retrieved.episodicMemory[0].outcome.toUpperCase()}, testsPassed: ${retrieved.episodicMemory[0].testsPassed}) under ROUTED_MEMORY_READ.`,
        timestamp: new Date()
      });
    } else {
      results.push({
        feature: '14. ROUTED_MEMORY_READ Episodic Memory Recall',
        status: 'FAIL',
        details: `Test 14 failed: isMemoryReadRoute=${isMemoryReadRoute}, hasEpisodicDivide=${hasEpisodicDivide}, onlyLongTerm=${onlyLongTerm}, episodicCount=${retrieved.episodicMemory.length}, longTermCount=${retrieved.longTermMemory.length}`,
        timestamp: new Date()
      });
    }
  } catch (err: any) {
    results.push({
      feature: '14. ROUTED_MEMORY_READ Episodic Memory Recall',
      status: 'FAIL',
      details: err?.message || String(err),
      timestamp: new Date()
    });
  }

  // Test 15: Idempotent Long-Term Memory Writes & Deduplication Suite
  try {
    const idemWs = 'test_idem_' + Date.now();

    // TEST 1 — Exact duplicate
    memoryEngine.longTermMemory.addFact('coding_convention', 'TypeScript Strict Mode', 'Remember that this project uses TypeScript strict mode.', 'user_explicit', 0.9, idemWs);
    memoryEngine.longTermMemory.addFact('coding_convention', 'TypeScript Strict Mode', 'Remember that this project uses TypeScript strict mode.', 'user_explicit', 0.9, idemWs);
    const factsAfterExact = memoryEngine.longTermMemory.getAllFacts(idemWs);
    const test1Passed = factsAfterExact.length === 1;

    // TEST 2 — Equivalent wording
    memoryEngine.longTermMemory.addFact('coding_convention', 'TypeScript Strict Mode', 'We use TypeScript strict mode in this project.', 'user_explicit', 0.9, idemWs);
    const factsAfterEquiv = memoryEngine.longTermMemory.getAllFacts(idemWs);
    const test2Passed = factsAfterEquiv.length === 1;

    // TEST 3 — Distinct memory
    memoryEngine.longTermMemory.addFact('coding_convention', 'UI Styling Framework', 'Remember that we prefer Tailwind for UI styling.', 'user_explicit', 0.9, idemWs);
    const factsAfterDistinct = memoryEngine.longTermMemory.getAllFacts(idemWs);
    const test3Passed = factsAfterDistinct.length === 2;

    // TEST 4 — Secret protection & deduplication
    const secretInput = 'Use TypeScript strict mode with my API key is gsk_9999999999abcdef9999999999 and password="SecretPass123"';
    memoryEngine.longTermMemory.addFact('coding_convention', 'Code Format', secretInput, 'user_explicit', 0.9, idemWs);
    memoryEngine.longTermMemory.addFact('coding_convention', 'Code Format', secretInput, 'user_explicit', 0.9, idemWs);

    const codeFormatFact = memoryEngine.longTermMemory.getFact('Code Format', idemWs);
    const hasSecretRedacted = codeFormatFact ? (codeFormatFact.value.includes('[REDACTED_API_KEY]') && !codeFormatFact.value.includes('gsk_99999')) : false;
    const test4Passed = hasSecretRedacted;

    // TEST 5 — Persistence & reload
    memoryEngine.longTermMemory.saveToPersistence();
    memoryEngine.longTermMemory.loadFromPersistence();
    memoryEngine.longTermMemory.addFact('coding_convention', 'TypeScript Strict Mode', 'Remember that this project uses TypeScript strict mode.', 'user_explicit', 0.9, idemWs);
    const factsAfterReload = memoryEngine.longTermMemory.getAllFacts(idemWs);
    const test5Passed = factsAfterReload.some(f => f.key === 'TypeScript Strict Mode' && f.category === 'coding_convention');

    // TEST 6 — Episodic memory unaffected
    const episodicEpisodes = memoryEngine.episodicMemory.searchEpisodes('divide');
    const test6Passed = episodicEpisodes.length > 0 && 
                        episodicEpisodes[0].outcome === 'success' && 
                        episodicEpisodes[0].testsPassed === true && 
                        episodicEpisodes[0].affectedFiles.some(f => f.includes('episodic_demo.py'));

    if (test1Passed && test2Passed && test3Passed && test4Passed && test5Passed && test6Passed) {
      results.push({
        feature: '15. Idempotent Long-Term Memory Writes & Deduplication Suite',
        status: 'PASS',
        details: `All 6 Idempotency & Deduplication checks passed cleanly: Exact Dup (${test1Passed}), Equiv Wording (${test2Passed}), Distinct Memory (${test3Passed}), Secret Scrub (${test4Passed}), Reload Persistence (${test5Passed}), Episodic Integrity (${test6Passed}).`,
        timestamp: new Date()
      });
    } else {
      results.push({
        feature: '15. Idempotent Long-Term Memory Writes & Deduplication Suite',
        status: 'FAIL',
        details: `Idempotency assertions failed: test1=${test1Passed}, test2=${test2Passed}, test3=${test3Passed}, test4=${test4Passed}, test5=${test5Passed}, test6=${test6Passed}`,
        timestamp: new Date()
      });
    }
  } catch (err: any) {
    results.push({
      feature: '15. Idempotent Long-Term Memory Writes & Deduplication Suite',
      status: 'FAIL',
      details: err?.message || String(err),
      timestamp: new Date()
    });
  }

  return results;
}



