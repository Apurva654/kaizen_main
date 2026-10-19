import { intentAgentNode, isBrowserQuery } from '../src/agents/intentAgent';

interface GoldenFixture {
  prompt: string;
  expectedRoute: string;
  category: string;
  mustNotBe?: string[];
}

export const GOLDEN_ROUTING_FIXTURES: GoldenFixture[] = [
  // --- Required User Scenarios ---
  {
    prompt: "Upgrade the existing KAIZEN SPEEDWAY 3D game with better physics and a minimap",
    expectedRoute: "GENERATE_CODE",
    category: "Game/Feature Upgrade with 'existing'",
    mustNotBe: ["MCP_BROWSER", "DEBUG_ERROR"]
  },
  {
    prompt: "Improve the existing calculator project with scientific functions",
    expectedRoute: "GENERATE_CODE",
    category: "Improve <existing project>",
    mustNotBe: ["MCP_BROWSER"]
  },
  {
    prompt: "Extend the existing authentication module to support OAuth2",
    expectedRoute: "GENERATE_CODE",
    category: "Extend <existing project>",
    mustNotBe: ["MCP_BROWSER"]
  },
  {
    prompt: "Enhance the existing dashboard with real-time websocket charts",
    expectedRoute: "GENERATE_CODE",
    category: "Enhance <existing project>",
    mustNotBe: ["MCP_BROWSER"]
  },
  {
    prompt: "Overhaul the existing navigation menu and make it responsive",
    expectedRoute: "GENERATE_CODE",
    category: "Overhaul <existing project>",
    mustNotBe: ["MCP_BROWSER"]
  },
  {
    prompt: "Revamp the existing landing page with modern pastel styling",
    expectedRoute: "GENERATE_CODE",
    category: "Revamp <existing project>",
    mustNotBe: ["MCP_BROWSER"]
  },
  {
    prompt: "Polish the existing user settings modal with smooth animations",
    expectedRoute: "GENERATE_CODE",
    category: "Polish <existing project>",
    mustNotBe: ["MCP_BROWSER"]
  },
  {
    prompt: "Refactor game.js into modules",
    expectedRoute: "REFACTOR",
    category: "Refactor source code"
  },
  {
    prompt: "TypeError: x is not a function at game.js:649, fix it",
    expectedRoute: "DEBUG_ERROR",
    category: "Explicit error diagnostic fix"
  },
  {
    prompt: "run the tests and fix failures",
    expectedRoute: "RUN_EXISTING_TESTS",
    category: "Test execution + fix"
  },
  {
    prompt: "open src/sandbox/index.html and inspect it",
    expectedRoute: "MCP_BROWSER",
    category: "Read-only browser inspection"
  },
  {
    prompt: "fix it",
    expectedRoute: "GENERAL_QUERY",
    category: "Ambiguous query clarification"
  },
  // --- 'existing' with build verb (MUST NEVER be MCP_BROWSER) ---
  {
    prompt: "Inspect the existing webpage and build a new contact form",
    expectedRoute: "GENERATE_CODE",
    category: "'existing' + build verb -> NEVER browser",
    mustNotBe: ["MCP_BROWSER"]
  },
  {
    prompt: "Open the existing project and upgrade the UI components",
    expectedRoute: "GENERATE_CODE",
    category: "'existing' + build verb -> NEVER browser",
    mustNotBe: ["MCP_BROWSER"]
  },
  {
    prompt: "View the existing index.html and add a search filter bar",
    expectedRoute: "GENERATE_CODE",
    category: "'existing' + build verb -> NEVER browser",
    mustNotBe: ["MCP_BROWSER"]
  },
  // --- Code Generation & Feature Creation ---
  {
    prompt: "Build a full-stack weather app in TypeScript with Tailwind CSS",
    expectedRoute: "GENERATE_CODE",
    category: "Fresh app generation"
  },
  {
    prompt: "Create a snake game in src/sandbox/index.html",
    expectedRoute: "GENERATE_CODE",
    category: "Create game in file"
  },
  {
    prompt: "Implement a binary search algorithm in src/sandbox/search.ts",
    expectedRoute: "GENERATE_CODE",
    category: "Implement algorithm"
  },
  {
    prompt: "Develop a portfolio-quality 3D Car Racing game with realistic 3D environments",
    expectedRoute: "GENERATE_CODE",
    category: "Develop 3D game"
  },
  {
    prompt: "Scaffold a REST API for managing todo items in TypeScript",
    expectedRoute: "GENERATE_CODE",
    category: "Scaffold REST API"
  },
  // --- Refactoring ---
  {
    prompt: "Refactor src/sandbox/calculator.ts to clean up duplicated logic",
    expectedRoute: "REFACTOR",
    category: "Refactor specific file"
  },
  {
    prompt: "Optimize the rendering loop in src/sandbox/game.js",
    expectedRoute: "REFACTOR",
    category: "Optimize performance"
  },
  {
    prompt: "Clean up the code in server.ts and remove unused imports",
    expectedRoute: "REFACTOR",
    category: "Remove unused imports"
  },
  {
    prompt: "Restructure the project files to follow feature folders",
    expectedRoute: "REFACTOR",
    category: "Restructure project"
  },
  // --- Debug / Error Fixing ---
  {
    prompt: "Fix the bug in src/sandbox/calculator.ts where division by zero throws an error",
    expectedRoute: "DEBUG_ERROR",
    category: "Fix bug in file"
  },
  {
    prompt: "Uncaught ReferenceError: window is not defined at server.js:12, resolve this issue",
    expectedRoute: "DEBUG_ERROR",
    category: "Runtime ReferenceError"
  },
  {
    prompt: "Debug the failing test in calculator.test.ts",
    expectedRoute: "DEBUG_ERROR",
    category: "Debug failing test"
  },
  {
    prompt: "Fix the broken submit button in src/sandbox/index.html",
    expectedRoute: "DEBUG_ERROR",
    category: "Fix broken button"
  },
  // --- Test Execution ---
  {
    prompt: "Run the existing unit test suite to verify everything passes",
    expectedRoute: "RUN_EXISTING_TESTS",
    category: "Run unit test suite"
  },
  {
    prompt: "execute pytest on src/sandbox",
    expectedRoute: "RUN_EXISTING_TESTS",
    category: "Execute pytest"
  },
  {
    prompt: "run npm test",
    expectedRoute: "RUN_EXISTING_TESTS",
    category: "Run npm test"
  },
  // --- Read-only Browser Operations ---
  {
    prompt: "Preview http://localhost:3000 in browser and take a screenshot",
    expectedRoute: "MCP_BROWSER",
    category: "Preview localhost URL"
  },
  {
    prompt: "launch browser and navigate to src/sandbox/index.html",
    expectedRoute: "MCP_BROWSER",
    category: "Navigate browser"
  },
  // --- Ambiguous / General Queries ---
  {
    prompt: "make it work",
    expectedRoute: "GENERAL_QUERY",
    category: "Ambiguous query"
  },
  {
    prompt: "What is a binary search tree?",
    expectedRoute: "GENERAL_QUERY",
    category: "Conceptual knowledge question"
  },
  // --- MCP Git, Terminal, and Memory ---
  {
    prompt: "git status and show changes",
    expectedRoute: "MCP_GIT",
    category: "Git status operation"
  },
  {
    prompt: "use terminal to run ls -la",
    expectedRoute: "MCP_TERMINAL",
    category: "Terminal command execution"
  },
  {
    prompt: "Delete the file src/sandbox/temp.txt",
    expectedRoute: "DELETE_FILES",
    category: "File deletion"
  },
  {
    prompt: "Remember that our team prefers 2 spaces indentation",
    expectedRoute: "MEMORY_WRITE",
    category: "Memory write"
  },
  {
    prompt: "What coding conventions do you remember?",
    expectedRoute: "MEMORY_READ",
    category: "Memory read"
  },
  {
    prompt: "Explain how src/agents/intentAgent.ts works",
    expectedRoute: "EXPLAIN_CODE",
    category: "Explain codebase code"
  }
];

export async function runRoutingGoldenTestSuite() {
  console.log('🧪 ========================================================');
  console.log(`🧪 KAIZEN AI - Golden Routing Fixtures Test Suite (${GOLDEN_ROUTING_FIXTURES.length} Prompts)`);
  console.log('🧪 Mode: Offline Deterministic Heuristics (CI-Safe / No API Key)');
  console.log('🧪 ========================================================\n');

  // Enforce offline deterministic heuristic path by ensuring GEMINI_API_KEY is not set
  const originalApiKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;

  let passed = 0;
  let failed = 0;
  const failureReports: string[] = [];

  try {
    for (let i = 0; i < GOLDEN_ROUTING_FIXTURES.length; i++) {
      const fixture = GOLDEN_ROUTING_FIXTURES[i];
      const state: any = {
        userInput: fixture.prompt,
        targetFiles: [],
        status: 'INITIALIZED'
      };

      const result = await intentAgentNode(state);
      const actualRoute = result.status.replace('ROUTED_', '');
      const expectedRoute = fixture.expectedRoute;

      const routeMatches = actualRoute === expectedRoute;
      let forbiddenViolated = false;

      if (fixture.mustNotBe && fixture.mustNotBe.length > 0) {
        for (const forbidden of fixture.mustNotBe) {
          if (actualRoute === forbidden) {
            forbiddenViolated = true;
          }
        }
      }

      // Check specific negative constraint for 'existing' + build verb
      if (fixture.category.includes('NEVER browser')) {
        const isBrowser = isBrowserQuery(fixture.prompt);
        if (isBrowser || actualRoute === 'MCP_BROWSER') {
          forbiddenViolated = true;
        }
      }

      if (routeMatches && !forbiddenViolated) {
        passed++;
        console.log(`  ✅ [${i + 1}/${GOLDEN_ROUTING_FIXTURES.length}] PASS: "${fixture.prompt.slice(0, 55)}..." -> ${actualRoute}`);
      } else {
        failed++;
        const reason = forbiddenViolated
          ? `Forbidden route matched: ${actualRoute} (Must not be: ${fixture.mustNotBe?.join(', ')})`
          : `Expected ${expectedRoute}, got ${actualRoute}`;
        console.error(`  ❌ [${i + 1}/${GOLDEN_ROUTING_FIXTURES.length}] FAIL: "${fixture.prompt}"`);
        console.error(`      Reason: ${reason}`);
        failureReports.push(`Prompt: "${fixture.prompt}" -> Expected: ${expectedRoute}, Actual: ${actualRoute}`);
      }
    }
  } finally {
    // Restore environment
    if (originalApiKey) {
      process.env.GEMINI_API_KEY = originalApiKey;
    }
  }

  console.log('\n========================================================');
  console.log(`🎉 GOLDEN ROUTING SUITE SUMMARY: ${passed}/${GOLDEN_ROUTING_FIXTURES.length} PASSED`);
  if (failed > 0) {
    console.error(`❌ ${failed} FIXTURES FAILED:`);
    failureReports.forEach(r => console.error(`   • ${r}`));
    console.log('========================================================\n');
    throw new Error(`${failed} golden routing tests failed.`);
  }
  console.log('========================================================\n');
}

// Direct execution entrypoint
if (require.main === module) {
  runRoutingGoldenTestSuite().catch((err) => {
    console.error('Test suite failed:', err);
    process.exit(1);
  });
}
