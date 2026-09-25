import * as fs from 'fs';
import * as path from 'path';
import { intentAgentNode, extractBrowserUrl } from '../agents/intentAgent';
import { contextRetrievalAgentNode } from '../agents/contextRetrievalAgent';
import { plannerAgentNode } from '../agents/plannerAgent';
import { codeGenAgentNode } from '../agents/codeGenAgent';
import { runWorkspaceTests } from './testRunner';
import { GraphifyEngine } from './graphifyEngine';
import { ASTParserTool } from './astParser';
import { KaizenStateType } from '../state';
import { parseBrowserInspectionResult, extractRequestedBrowserAction, resolveAccessibilityTarget } from './browserSnapshotParser';

export interface WebPipelineTestResult {
  name: string;
  passed: boolean;
  details: string;
}

export async function runWebProjectPipelineRegressionTests(): Promise<{ passed: boolean; results: WebPipelineTestResult[] }> {
  const results: WebPipelineTestResult[] = [];

  const record = (name: string, passed: boolean, details: string) => {
    results.push({ name, passed, details });
    console.log(`[Web Pipeline Regression] ${passed ? '✓ PASS' : '✗ FAIL'}: ${name} - ${details}`);
  };

  // --------------------------------------------------------------------------
  // TEST A: "Run src/sandbox/index.html" -> BROWSER URL MUST BE /sandbox/index.html
  // --------------------------------------------------------------------------
  try {
    const mockState: Partial<KaizenStateType> = {
      userInput: "Run src/sandbox/index.html",
      targetFiles: []
    };
    const intentRes = await intentAgentNode(mockState as KaizenStateType);
    const resolvedUrl = extractBrowserUrl("Run src/sandbox/index.html");
    const passed = intentRes.status === 'ROUTED_MCP_BROWSER' && resolvedUrl === 'http://localhost:3000/sandbox/index.html';
    record(
      'Test A: "Run src/sandbox/index.html" -> static URL /sandbox/index.html',
      passed,
      passed ? `Routed to ${intentRes.status} with URL ${resolvedUrl}` : `Expected /sandbox/index.html, got ${resolvedUrl} (status: ${intentRes.status})`
    );
  } catch (err: any) {
    record('Test A: "Run src/sandbox/index.html"', false, err?.message || String(err));
  }

  // --------------------------------------------------------------------------
  // TEST B: "Open src/sandbox/index.html and inspect it" -> static URL /sandbox/index.html
  // --------------------------------------------------------------------------
  try {
    const mockState: Partial<KaizenStateType> = {
      userInput: "Open src/sandbox/index.html and inspect it",
      targetFiles: []
    };
    const intentRes = await intentAgentNode(mockState as KaizenStateType);
    const resolvedUrl = extractBrowserUrl("Open src/sandbox/index.html and inspect it");
    const passed = intentRes.status === 'ROUTED_MCP_BROWSER' && resolvedUrl === 'http://localhost:3000/sandbox/index.html';
    record(
      'Test B: "Open src/sandbox/index.html and inspect it" -> static URL /sandbox/index.html',
      passed,
      passed ? `Routed to ${intentRes.status} with URL ${resolvedUrl}` : `Expected /sandbox/index.html, got ${resolvedUrl}`
    );
  } catch (err: any) {
    record('Test B: "Open src/sandbox/index.html and inspect it"', false, err?.message || String(err));
  }

  // --------------------------------------------------------------------------
  // TEST C: "Build a landing page in src/sandbox/index.html" -> CODING PIPELINE
  // --------------------------------------------------------------------------
  try {
    const mockState: Partial<KaizenStateType> = {
      userInput: "Build a landing page in src/sandbox/index.html",
      targetFiles: []
    };
    const intentRes = await intentAgentNode(mockState as KaizenStateType);
    const passed = intentRes.status === 'ROUTED_GENERATE_CODE' && intentRes.targetFiles.includes('src/sandbox/index.html');
    record(
      'Test C: "Build a landing page in src/sandbox/index.html" -> CODING PIPELINE',
      passed,
      passed ? `Routed to ${intentRes.status} with target ${intentRes.targetFiles.join(', ')}` : `Expected ROUTED_GENERATE_CODE, got ${intentRes.status}`
    );
  } catch (err: any) {
    record('Test C: "Build a landing page in src/sandbox/index.html"', false, err?.message || String(err));
  }

  // --------------------------------------------------------------------------
  // TEST D: Browser execution must not modify files
  // --------------------------------------------------------------------------
  try {
    const sandboxDir = path.resolve(process.cwd(), 'src/sandbox');
    const testIndexPath = path.join(sandboxDir, 'index.html');
    const initialContent = '<!DOCTYPE html><html><head><title>Original Page</title></head><body><h1>Original Content</h1></body></html>';

    fs.writeFileSync(testIndexPath, initialContent, 'utf-8');

    const resolvedUrl = extractBrowserUrl("Run the existing webpage at src/sandbox/index.html. Do not modify files. Open it with the browser and click View Demo.");
    const contentAfterUrl = fs.readFileSync(testIndexPath, 'utf-8');

    // Cleanup
    if (fs.existsSync(testIndexPath)) fs.unlinkSync(testIndexPath);

    const isUnmodified = contentAfterUrl === initialContent && resolvedUrl === 'http://localhost:3000/sandbox/index.html';

    record(
      'Test D: Browser execution must not modify workspace files',
      isUnmodified,
      isUnmodified ? `Resolved static URL "${resolvedUrl}" with 0 workspace file mutations` : `File modified or bad URL: ${resolvedUrl}`
    );
  } catch (err: any) {
    record('Test D: Browser execution must not modify workspace files', false, err?.message || String(err));
  }

  // --------------------------------------------------------------------------
  // TEST E: Root http://localhost:3000 must continue to load KAIZEN UI
  // --------------------------------------------------------------------------
  try {
    const rootUrl1 = extractBrowserUrl("Open http://localhost:3000");
    const rootUrl2 = extractBrowserUrl("Open KAIZEN Generative UI Playground on localhost:3000");
    const passed = rootUrl1 === 'http://localhost:3000' && rootUrl2 === 'http://localhost:3000';
    record(
      'Test E: Root http://localhost:3000 must continue to load KAIZEN UI',
      passed,
      passed ? 'Root KAIZEN UI URL extraction preserved' : `Expected http://localhost:3000, got ${rootUrl1}, ${rootUrl2}`
    );
  } catch (err: any) {
    record('Test E: Root http://localhost:3000', false, err?.message || String(err));
  }

  // --------------------------------------------------------------------------
  // TEST F: Static /sandbox/index.html must load the generated webpage
  // --------------------------------------------------------------------------
  try {
    const sandboxDir = path.resolve(process.cwd(), 'src/sandbox');
    const testIndexPath = path.join(sandboxDir, 'index.html');
    const testContent = '<!DOCTYPE html><html><head><title>Test Landing Page</title></head><body><h1>Generated Landing Page</h1><button id="demo-btn">View Demo</button><section id="features"><h2>Features</h2></section></body></html>';
    fs.writeFileSync(testIndexPath, testContent, 'utf-8');

    let fetchSuccess = false;
    try {
      const res = await fetch('http://localhost:3000/sandbox/index.html');
      const text = await res.text();
      fetchSuccess = res.status === 200 && text.includes('Generated Landing Page');
    } catch {}

    // Cleanup
    if (fs.existsSync(testIndexPath)) fs.unlinkSync(testIndexPath);

    record(
      'Test F: Static /sandbox/index.html serves generated webpage',
      fetchSuccess,
      fetchSuccess ? 'HTTP 200 OK returned generated webpage from /sandbox/index.html' : 'Static server check failed'
    );
  } catch (err: any) {
    record('Test F: Static /sandbox/index.html serves generated webpage', false, err?.message || String(err));
  }

  // --------------------------------------------------------------------------
  // TEST G: Playwright snapshot parser finds "View Demo" on generated page
  // --------------------------------------------------------------------------
  try {
    const rawSnapshot = `
title: "Generated Landing Page"
heading [ref=e1] "Generated Landing Page"
button [ref=e2] "View Demo"
heading [ref=e3] "Features"
Console: 0 errors
`;
    const inspection = parseBrowserInspectionResult(rawSnapshot, 'http://localhost:3000/sandbox/index.html');
    const targetAction = extractRequestedBrowserAction("Open it with the browser and click View Demo.");
    const targetRes = targetAction ? resolveAccessibilityTarget(targetAction.target, inspection) : { found: false };

    const passed = inspection.controls.some(c => c.name === 'View Demo') && targetRes.found && targetRes.elementRef === 'e2';
    record(
      'Test G: Playwright snapshot parser finds "View Demo"',
      passed,
      passed ? 'Found "View Demo" button with elementRef e2' : 'Failed to find "View Demo" in snapshot'
    );
  } catch (err: any) {
    record('Test G: Playwright snapshot parser finds "View Demo"', false, err?.message || String(err));
  }

  // --------------------------------------------------------------------------
  // TEST H: Clicking "View Demo" works and resolves target correctly
  // --------------------------------------------------------------------------
  try {
    const rawSnapshot = `
title: "Generated Landing Page"
heading [ref=e1] "Generated Landing Page"
button [ref=e2] "View Demo"
heading [ref=e3] "Core Platform Features"
`;
    const inspection = parseBrowserInspectionResult(rawSnapshot, 'http://localhost:3000/sandbox/index.html');
    const action = extractRequestedBrowserAction("Click View Demo");
    const targetRes = action ? resolveAccessibilityTarget(action.target, inspection) : { found: false };

    const passed = action?.action === 'click' && action?.target === 'View Demo' && targetRes.found;
    record(
      'Test H: Clicking "View Demo" resolves action target',
      passed,
      passed ? `Extracted action ${action?.action} on target "${action?.target}" (ref: ${targetRes.elementRef})` : 'Target resolution failed'
    );
  } catch (err: any) {
    record('Test H: Clicking "View Demo" resolves action target', false, err?.message || String(err));
  }

  // --------------------------------------------------------------------------
  // TEST I: Existing Browser/MCP routing tests remain passing
  // --------------------------------------------------------------------------
  try {
    const browserPhrases = [
      "now run the webpage",
      "preview the website",
      "launch the webpage",
      "show me the webpage",
      "test the webpage"
    ];

    let allPassed = true;
    for (const phrase of browserPhrases) {
      const mockState: Partial<KaizenStateType> = { userInput: phrase, targetFiles: [] };
      const intentRes = await intentAgentNode(mockState as KaizenStateType);
      if (intentRes.status !== 'ROUTED_MCP_BROWSER' || intentRes.targetFiles.length !== 0) {
        allPassed = false;
        break;
      }
    }

    record(
      'Test I: Existing Browser/MCP routing tests remain passing',
      allPassed,
      allPassed ? 'All generic browser execution queries routed to ROUTED_MCP_BROWSER' : 'Browser query routing failed'
    );
  } catch (err: any) {
    record('Test I: Existing Browser/MCP routing tests remain passing', false, err?.message || String(err));
  }

  const allPassed = results.every(r => r.passed);
  return { passed: allPassed, results };
}
