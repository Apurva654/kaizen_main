import * as fs from 'fs';
import * as path from 'path';
import {
  debuggerAgentNode,
  isTestFile,
  resolveImplementationTarget,
  extractFailureDetails,
  DebuggerSchema
} from '../src/agents/debuggerAgent';
import { normalizeSandboxPath, isProtectedFile } from '../src/tools/sandboxPathUtils';

async function runDebuggerAgentTestSuite() {
  console.log('🧪 ========================================================');
  console.log('🧪 KAIZEN AI - DebuggerAgent Hardening Regression Test Suite');
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

  const baseState = (overrides: any = {}): any => ({
    userInput: 'Fix bug',
    originalUserRequest: 'Fix bug',
    targetFiles: ['src/sandbox/calculator.ts'],
    structuredFailures: [],
    testLogs: '',
    compilerError: '',
    extractedContext: '',
    retryCount: 0,
    status: 'INITIALIZED',
    ...overrides
  });

  // Ensure test sandbox directory exists for mock fixtures
  const sandboxDir = path.resolve(process.cwd(), 'src/sandbox');
  if (!fs.existsSync(sandboxDir)) {
    fs.mkdirSync(sandboxDir, { recursive: true });
  }

  // Temporary fixture for resolution tests
  const testFixtureImpl = path.resolve(sandboxDir, 'test_fixture_calc.ts');
  const testFixtureTest = path.resolve(sandboxDir, 'test_fixture_calc.test.ts');
  fs.writeFileSync(testFixtureImpl, 'export function add(a: number, b: number) { return a + b; }\n');
  fs.writeFileSync(testFixtureTest, "import { add } from './test_fixture_calc';\n");

  try {
    // 1. Correctly diagnose a genuine implementation bug
    console.log('\n--- 1. Correctly diagnose a genuine implementation bug ---');
    const mockRunner1 = async () => ({
      result: {
        rootCause: 'Off-by-one error in loop condition',
        fixExplanation: 'Adjusted loop boundary from <= to < to avoid index out of bounds.',
        files: [
          {
            filePath: 'src/sandbox/calculator.ts',
            code: 'export function calculate() { return 42; }\n'
          }
        ]
      },
      model: 'mock-gemini'
    });

    const res1 = await debuggerAgentNode(baseState(), { runStructuredFn: mockRunner1 as any });
    assert(res1.status === 'DEBUG_FIX_GENERATED', 'Returns DEBUG_FIX_GENERATED status');
    assert(res1.rootCause.includes('Off-by-one'), 'Extracts rootCause diagnosis');
    assert(res1.filePatches.length === 1, 'Contains 1 file patch');
    assert(res1.filePatches[0].filePath === 'src/sandbox/calculator.ts', 'Targets calculator.ts');
    assert(res1.filePatches[0].code.includes('42'), 'Patch contains correct code');

    // 2. Fix a compiler/type error using supplied diagnostics
    console.log('\n--- 2. Fix a compiler/type error using supplied diagnostics ---');
    let systemPromptCaptured = '';
    const mockRunner2 = async (opts: any) => {
      systemPromptCaptured = opts.system;
      return {
        result: {
          rootCause: 'Type string is not assignable to type number',
          fixExplanation: 'Parsed string input to integer.',
          files: [
            {
              filePath: 'src/sandbox/calculator.ts',
              code: 'export function parseVal(x: string): number { return parseInt(x, 10); }\n'
            }
          ]
        },
        model: 'mock-gemini'
      };
    };

    const res2 = await debuggerAgentNode(
      baseState({ compilerError: "src/sandbox/calculator.ts(5,3): error TS2322: Type 'string' is not assignable to type 'number'." }),
      { runStructuredFn: mockRunner2 as any }
    );
    assert(res2.status === 'DEBUG_FIX_GENERATED', 'Generates fix for compiler error');
    assert(systemPromptCaptured.includes('Type string is not assignable to type number') || systemPromptCaptured.includes('TS2322'), 'Compiler error included in prompt diagnostics');

    // 3. Fix a failing assertion without modifying the test
    console.log('\n--- 3. Fix a failing assertion without modifying the test ---');
    const mockRunner3 = async () => ({
      result: {
        rootCause: 'Assertion expected 10 but got 9',
        fixExplanation: 'Corrected calculation logic.',
        files: [
          { filePath: 'src/sandbox/calculator.ts', code: 'export function val() { return 10; }\n' },
          { filePath: 'src/sandbox/calculator.test.ts', code: 'test("fake", () => { expect(1).toBe(1); });\n' }
        ]
      },
      model: 'mock-gemini'
    });

    const res3 = await debuggerAgentNode(baseState(), { runStructuredFn: mockRunner3 as any });
    assert(res3.filePatches.length === 1, 'Only implementation patch accepted');
    assert(res3.filePatches[0].filePath === 'src/sandbox/calculator.ts', 'Implementation patch targets calculator.ts');
    assert(!res3.filePatches.some(p => isTestFile(p.filePath)), 'Test file patch was strictly rejected');

    // 4. Resolve an explicitly specified implementation target
    console.log('\n--- 4. Resolve an explicitly specified implementation target ---');
    const { resolvedTargets: rt4 } = resolveImplementationTarget(['src/sandbox/custom_service.ts']);
    assert(rt4.length === 1, 'Resolves 1 explicit target');
    assert(rt4[0] === 'src/sandbox/custom_service.ts', 'Resolves exact sandbox path');

    // 5. Handle a test-only target with a reliably identifiable implementation
    console.log('\n--- 5. Handle a test-only target with a reliably identifiable implementation ---');
    const { resolvedTargets: rt5, testFileCandidate: tf5 } = resolveImplementationTarget(['src/sandbox/test_fixture_calc.test.ts']);
    assert(rt5.length === 1, 'Resolves corresponding implementation');
    assert(rt5[0] === 'src/sandbox/test_fixture_calc.ts', 'Maps test file to implementation file on disk');
    assert(tf5 === 'src/sandbox/test_fixture_calc.test.ts', 'Identifies test candidate');

    // 6. Fail safely when the implementation target is unknown
    console.log('\n--- 6. Fail safely when the implementation target is unknown ---');
    const res6 = await debuggerAgentNode(baseState({ targetFiles: [] }));
    assert(res6.status === 'DEBUG_FAILED', 'Returns DEBUG_FAILED when no target specified');
    assert(res6.filePatches.length === 0, 'No speculative file patches generated');
    assert(res6.rootCause.includes('No implementation target') || res6.rootCause.includes('resolve implementation'), 'Explains missing target in rootCause');

    // 7. Never select an arbitrary sandbox file
    console.log('\n--- 7. Never select an arbitrary sandbox file ---');
    const { resolvedTargets: rt7 } = resolveImplementationTarget(['src/sandbox/test_completely_orphan_xyz.py']);
    assert(rt7.length === 0, 'Does NOT select arbitrary first file in sandbox when impl is unknown');
    const res7 = await debuggerAgentNode(baseState({ targetFiles: ['src/sandbox/test_completely_orphan_xyz.py'] }));
    assert(res7.status === 'DEBUG_FAILED', 'Returns DEBUG_FAILED for unresolvable test file');
    assert(res7.filePatches.length === 0, 'Empty file patches returned');

    // 8. Never replace an unrelated file with a hardcoded division function
    console.log('\n--- 8. Never replace an unrelated file with a hardcoded division function ---');
    const originalKey8 = process.env.GEMINI_API_KEY;
    try {
      process.env.GEMINI_API_KEY = '';
      const res8 = await debuggerAgentNode(baseState({ targetFiles: ['src/sandbox/calculator.ts'] }));
      assert(res8.status === 'DEBUG_FAILED', 'Returns DEBUG_FAILED without LLM');
      assert(res8.filePatches.length === 0, 'Never generates hardcoded divide patches');
      assert(!res8.fixExplanation.includes('divide'), 'Does not apply division fallback');
    } finally {
      process.env.GEMINI_API_KEY = originalKey8;
    }

    // 9. Handle missing source code or missing test context
    console.log('\n--- 9. Handle missing source code or missing test context ---');
    let capturedPrompt9 = '';
    const mockRunner9 = async (opts: any) => {
      capturedPrompt9 = opts.system;
      return {
        result: {
          rootCause: 'Missing file needs to be initialized',
          fixExplanation: 'Created initial skeleton',
          files: [{ filePath: 'src/sandbox/nonexistent_file.ts', code: 'export const x = 1;\n' }]
        },
        model: 'mock-gemini'
      };
    };
    const res9 = await debuggerAgentNode(baseState({ targetFiles: ['src/sandbox/nonexistent_file.ts'] }), { runStructuredFn: mockRunner9 as any });
    assert(capturedPrompt9.includes('(Missing or empty source file)'), 'Prompt safely mentions missing source code');
    assert(capturedPrompt9.includes('(No test source available)'), 'Prompt safely mentions missing test code');
    assert(res9.status === 'DEBUG_FIX_GENERATED', 'Handles missing source without crashing');

    // 10. Include both test logs and extracted diagnostic context when available
    console.log('\n--- 10. Include both test logs and extracted diagnostic context when available ---');
    const diagState = baseState({
      testLogs: 'FAILURE: AssertionError in test_runner',
      extractedContext: 'AST Context: class Greeter has method greet()'
    });
    const details10 = extractFailureDetails(diagState);
    assert(details10.includes('FAILURE: AssertionError in test_runner'), 'Includes automated test logs');
    assert(details10.includes('AST Context: class Greeter has method greet()'), 'Preserves extractedContext alongside testLogs');

    // 11. Handle malformed Gemini output
    console.log('\n--- 11. Handle malformed Gemini output ---');
    const mockRunner11 = async () => {
      throw new Error('JSON parsing failed: unexpected token at line 1');
    };
    const res11 = await debuggerAgentNode(baseState(), { runStructuredFn: mockRunner11 as any });
    assert(res11.status === 'DEBUG_FAILED', 'Handles malformed output safely without crashing');
    assert(res11.filePatches.length === 0, 'No file patches generated on error');
    assert(res11.rootCause.includes('Diagnostic failure'), 'Informative rootCause provided');

    // 12. Handle missing API keys and model failures
    console.log('\n--- 12. Handle missing API keys and model failures ---');
    const originalKey12 = process.env.GEMINI_API_KEY;
    try {
      process.env.GEMINI_API_KEY = 'your_gemini_api_key_here';
      const res12 = await debuggerAgentNode(baseState());
      assert(res12.status === 'DEBUG_FAILED', 'Handles placeholder API key cleanly');
      assert(res12.rootCause.includes('missing GEMINI_API_KEY'), 'Explains missing API key');
    } finally {
      process.env.GEMINI_API_KEY = originalKey12;
    }

    // 13. Reject protected-file and test-file patches
    console.log('\n--- 13. Reject protected-file and test-file patches ---');
    const mockRunner13 = async () => ({
      result: {
        rootCause: 'Attempting to patch protected core files',
        fixExplanation: 'Malicious or misguided patch',
        files: [
          { filePath: 'package.json', code: '{ "name": "hacked" }' },
          { filePath: 'src/server.ts', code: 'console.log("hacked");' },
          { filePath: 'src/sandbox/test_calc.py', code: 'def test_pass(): pass' }
        ]
      },
      model: 'mock-gemini'
    });
    const res13 = await debuggerAgentNode(baseState(), { runStructuredFn: mockRunner13 as any });
    assert(res13.status === 'DEBUG_FAILED', 'All invalid patches rejected, status DEBUG_FAILED');
    assert(res13.filePatches.length === 0, 'Protected files and test files completely rejected');

    // 14. Reject empty, malformed, or invalid patch paths
    console.log('\n--- 14. Reject empty, malformed, or invalid patch paths ---');
    const mockRunner14 = async () => ({
      result: {
        rootCause: 'Malformed patch paths',
        fixExplanation: 'None',
        files: [
          { filePath: '', code: 'export const a = 1;' },
          { filePath: '../../secret.txt', code: 'malicious' },
          { code: 'missing path' } as any
        ]
      },
      model: 'mock-gemini'
    });
    const res14 = await debuggerAgentNode(baseState(), { runStructuredFn: mockRunner14 as any });
    assert(res14.filePatches.length === 0, 'No malformed or escaped patch paths accepted');
    assert(res14.status === 'DEBUG_FAILED', 'Rejection results in DEBUG_FAILED');

    // 15. Preserve sandbox path-normalization behaviour
    console.log('\n--- 15. Preserve sandbox path-normalization behaviour ---');
    assert(normalizeSandboxPath('calc.ts') === 'src/sandbox/calc.ts', 'Bare filename normalized to src/sandbox/');
    assert(normalizeSandboxPath('src/calc.ts') === 'src/sandbox/calc.ts', 'src/ path remapped to src/sandbox/');
    assert(normalizeSandboxPath('src/sandbox/calc.ts') === 'src/sandbox/calc.ts', 'Existing sandbox path preserved');
    assert(normalizeSandboxPath('../escape.ts') === '', 'Traversal path safely rejected');

    // 16. Reject unauthorized patch targets
    console.log('\n--- 16. Reject unauthorized patch targets ---');
    assert(isProtectedFile('src/server.ts') === true, 'src/server.ts is protected');
    assert(isProtectedFile('package.json') === true, 'package.json is protected');
    assert(isProtectedFile('.env') === true, '.env is protected');
    assert(isProtectedFile('src/sandbox/calculator.ts') === false, 'src/sandbox/calculator.ts is unprotected');

    // 17. Preserve existing exports, signatures, and unrelated code
    console.log('\n--- 17. Preserve existing exports, signatures, and unrelated code ---');
    // Ensure DebuggerSchema retains optional field aliases without schema rejection
    const parsedValid = DebuggerSchema.safeParse({
      root_cause: 'Evidence shows bug in adder',
      fix_explanation: 'Retained all existing exports',
      patches: [{ filePath: 'src/sandbox/calculator.ts', code: 'export function add() {}' }]
    });
    assert(parsedValid.success === true, 'DebuggerSchema safely parses field aliases');

    // 18. Return the correct existing status when no reliable fix is available
    console.log('\n--- 18. Return correct existing status when no reliable fix is available ---');
    const mockRunner18 = async () => ({
      result: {
        rootCause: 'Cannot identify fix from given logs',
        fixExplanation: 'Uncertainty remains',
        files: []
      },
      model: 'mock-gemini'
    });
    const res18 = await debuggerAgentNode(baseState(), { runStructuredFn: mockRunner18 as any });
    assert(res18.status === 'DEBUG_FAILED', 'Status is DEBUG_FAILED when no patches available');

    // 19. Handle successful patch generation without claiming validation occurred
    console.log('\n--- 19. Handle successful patch generation without claiming validation occurred ---');
    const mockRunner19 = async () => ({
      result: {
        rootCause: 'Identified syntax error in return statement',
        fixExplanation: 'Added missing closing parenthesis',
        files: [{ filePath: 'src/sandbox/calculator.ts', code: 'export function calc() { return (1 + 2); }\n' }]
      },
      model: 'mock-gemini'
    });
    const res19 = await debuggerAgentNode(baseState(), { runStructuredFn: mockRunner19 as any });
    assert(res19.status === 'DEBUG_FIX_GENERATED', 'Status is DEBUG_FIX_GENERATED (not completed/validated)');
    assert(res19.status !== 'DEBUG_COMPLETED', 'Does NOT claim validation completed before test runner runs');

    // 20. Confirm that the existing downstream validation workflow receives the generated patch correctly
    console.log('\n--- 20. Confirm downstream validation workflow receives generated patch correctly ---');
    assert(Array.isArray(res19.filePatches), 'filePatches is an array');
    assert(typeof res19.filePatches[0].filePath === 'string', 'filePath is string');
    assert(typeof res19.filePatches[0].code === 'string', 'code is string');
    assert(res19.filePatches[0].code.endsWith('\n'), 'Code is properly sanitized with newline termination');

    console.log('\n========================================================');
    console.log(`🎉 ALL 20 DEBUGGER REGRESSION SCENARIOS VERIFIED: ${passedTests}/${totalTests} checks passed`);
    console.log('========================================================\n');
  } finally {
    // Clean up temporary fixtures
    if (fs.existsSync(testFixtureImpl)) fs.unlinkSync(testFixtureImpl);
    if (fs.existsSync(testFixtureTest)) fs.unlinkSync(testFixtureTest);
  }
}

runDebuggerAgentTestSuite().catch((err) => {
  console.error('Debugger test suite failed with error:', err);
  process.exit(1);
});
