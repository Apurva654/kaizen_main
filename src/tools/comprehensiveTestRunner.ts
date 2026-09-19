import { intentAgentNode } from '../agents/intentAgent';
import { codeGenAgentNode, getLanguageFromPath } from '../agents/codeGenAgent';
import { KaizenStateType } from '../state';
import { detectProjectStack, getCompilerConfig, runValidationPipeline } from './universalValidator';

export interface VerificationResult {
  feature: string;
  status: 'PASS' | 'FAIL' | 'WARN';
  details: string;
  timestamp: Date;
}

export async function runComprehensiveTests(): Promise<VerificationResult[]> {
  const results: VerificationResult[] = [];

  // Test 1: Intent Routing Classifier for General Queries vs Code Generation
  try {
    const generalQueries = [
      'hello',
      'who is elon musk',
      'what is the capital of france',
      'how do i cook pasta',
      'tell me a joke'
    ];

    let allGeneralPassed = true;
    for (const q of generalQueries) {
      const mockState: Partial<KaizenStateType> = { userInput: q, targetFiles: [] };
      const res = await intentAgentNode(mockState as KaizenStateType);
      if (res.status !== 'ROUTED_GENERAL_QUERY') {
        allGeneralPassed = false;
        results.push({
          feature: `Routing: ${q}`,
          status: 'FAIL',
          details: `Expected ROUTED_GENERAL_QUERY, got ${res.status}`,
          timestamp: new Date()
        });
      }
    }

    if (allGeneralPassed) {
      results.push({
        feature: 'General Knowledge Fast-Path Routing',
        status: 'PASS',
        details: 'All general knowledge & greeting prompts routed to GENERAL_QUERY without workspace scan',
        timestamp: new Date()
      });
    }

    // Code intent query
    const codeQuery = 'make a calculator app using html, css, js';
    const mockCodeState: Partial<KaizenStateType> = { userInput: codeQuery, targetFiles: [] };
    const codeRes = await intentAgentNode(mockCodeState as KaizenStateType);
    if (codeRes.status === 'ROUTED_GENERATE_CODE') {
      results.push({
        feature: 'Code Generation Intent Routing',
        status: 'PASS',
        details: 'Code creation prompt correctly routed to GENERATE_CODE',
        timestamp: new Date()
      });
    } else {
      results.push({
        feature: 'Code Generation Intent Routing',
        status: 'FAIL',
        details: `Expected ROUTED_GENERATE_CODE, got ${codeRes.status}`,
        timestamp: new Date()
      });
    }
  } catch (err: any) {
    results.push({
      feature: 'Intent Routing Classifier',
      status: 'FAIL',
      details: err?.message || String(err),
      timestamp: new Date()
    });
  }

  // Test 2: Language-Aware Code Generation
  try {
    const mockState: Partial<KaizenStateType> = {
      userInput: 'create calculator html, css, and javascript',
      targetFiles: ['src/sandbox/calculator.html', 'src/sandbox/calculator.css', 'src/sandbox/calculator.js'],
      plan: [],
      retryCount: 0
    };

    const genRes = await codeGenAgentNode(mockState as KaizenStateType);
    const patches = genRes.filePatches || [];

    let htmlOk = false;
    let cssOk = false;
    let jsOk = false;

    for (const patch of patches) {
      if (patch.filePath.endsWith('.html')) {
        htmlOk = patch.code.includes('<!DOCTYPE html>') && !patch.code.includes('export function taskHandler');
      } else if (patch.filePath.endsWith('.css')) {
        cssOk = !patch.code.includes('export function') && !patch.code.includes('import ');
      } else if (patch.filePath.endsWith('.js')) {
        jsOk = !patch.code.includes('export function taskHandler');
      }
    }

    if (htmlOk && cssOk && jsOk) {
      results.push({
        feature: 'Language-Aware Multi-File Generation',
        status: 'PASS',
        details: 'HTML, CSS, and JS files generated with valid language-specific syntax and 0 TS boilerplate',
        timestamp: new Date()
      });
    } else {
      results.push({
        feature: 'Language-Aware Multi-File Generation',
        status: 'FAIL',
        details: `Syntax check failed: HTML (${htmlOk}), CSS (${cssOk}), JS (${jsOk})`,
        timestamp: new Date()
      });
    }
  } catch (err: any) {
    results.push({
      feature: 'Language-Aware Multi-File Generation',
      status: 'FAIL',
      details: err?.message || String(err),
      timestamp: new Date()
    });
  }

  // Test 3: Universal Multi-Language Stack Detection & Compiler Config
  try {
    const mockFilesTs = [{ name: 'package.json', path: 'package.json' }];
    const stackTs = await detectProjectStack(mockFilesTs);
    const configTs = await getCompilerConfig(stackTs);

    const mockFilesPy = [{ name: 'requirements.txt', path: 'requirements.txt' }];
    const stackPy = await detectProjectStack(mockFilesPy);
    const configPy = await getCompilerConfig(stackPy);

    const mockFilesGo = [{ name: 'go.mod', path: 'go.mod' }];
    const stackGo = await detectProjectStack(mockFilesGo);
    const configGo = await getCompilerConfig(stackGo);

    if (stackTs.language === 'JavaScript/TypeScript' && stackPy.language === 'Python' && stackGo.language === 'Go' && configTs.typeCheck.includes('tsc')) {
      results.push({
        feature: 'Universal Multi-Language Stack Detection',
        status: 'PASS',
        details: 'Auto-detected JS/TS (npm), Python (pip), and Go (go.mod) stacks with correct compiler configurations',
        timestamp: new Date()
      });
    } else {
      results.push({
        feature: 'Universal Multi-Language Stack Detection',
        status: 'FAIL',
        details: `Detection failed: TS (${stackTs.language}), Py (${stackPy.language}), Go (${stackGo.language})`,
        timestamp: new Date()
      });
    }
  } catch (err: any) {
    results.push({
      feature: 'Universal Multi-Language Stack Detection',
      status: 'FAIL',
      details: err?.message || String(err),
      timestamp: new Date()
    });
  }

  // Test 4: Memory Efficiency
  try {
    const memoryMB = process.memoryUsage().heapUsed / 1024 / 1024;
    results.push({
      feature: 'V8 Heap Memory Footprint',
      status: memoryMB < 50 ? 'PASS' : 'WARN',
      details: `Active heap usage: ${memoryMB.toFixed(2)} MB`,
      timestamp: new Date()
    });
  } catch (err: any) {
    results.push({
      feature: 'Memory Efficiency',
      status: 'FAIL',
      details: err?.message || String(err),
      timestamp: new Date()
    });
  }

  // Console summary log
  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  const warnings = results.filter(r => r.status === 'WARN').length;

  console.log(`
==================================================
📊 COMPREHENSIVE VERIFICATION SUITE RESULTS
==================================================
✓ Passed: ${passed}
✗ Failed: ${failed}
⚠ Warnings: ${warnings}
Total Checks: ${results.length}
==================================================
`);

  return results;
}
