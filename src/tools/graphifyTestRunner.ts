import { GraphifyEngine } from './graphifyEngine';
import { ASTParserTool } from './astParser';
import * as fs from 'fs';
import * as path from 'path';

export async function runGraphifyVerificationTests(): Promise<{ passed: boolean; results: Array<{ test: string; status: 'PASS' | 'FAIL'; details: string }> }> {
  const results: Array<{ test: string; status: 'PASS' | 'FAIL'; details: string }> = [];

  const engine = new GraphifyEngine();
  const sandboxPath = fs.existsSync('src/sandbox') ? 'src/sandbox' : '.';
  await engine.scanDirectory(sandboxPath);

  // 1. Symbol Metadata
  try {
    const payload = engine.exportGraphData({ scope: 'full', targetFiles: ['src/sandbox/student_result.py'] });
    const mainSymbolNode = payload.nodes.find(n => n.type === 'symbol' && n.label.includes('main'));

    if (mainSymbolNode && mainSymbolNode.startLine && mainSymbolNode.endLine && mainSymbolNode.signature && mainSymbolNode.complexity !== undefined) {
      results.push({
        test: 'Symbol Metadata Extraction',
        status: 'PASS',
        details: `Extracted main() metadata: startLine=${mainSymbolNode.startLine}, endLine=${mainSymbolNode.endLine}, signature="${mainSymbolNode.signature}", complexity=${mainSymbolNode.complexity}`
      });
    } else {
      results.push({
        test: 'Symbol Metadata Extraction',
        status: 'FAIL',
        details: `Failed to extract symbol metadata: ${JSON.stringify(mainSymbolNode)}`
      });
    }
  } catch (err: any) {
    results.push({ test: 'Symbol Metadata Extraction', status: 'FAIL', details: err?.message || String(err) });
  }

  // 2. File Metadata
  try {
    const payload = engine.exportGraphData({ scope: 'full' });
    const studentResultNode = payload.nodes.find(n => n.type === 'file' && n.id.includes('student_result.py'));

    if (studentResultNode && studentResultNode.symbolsCount && studentResultNode.symbolsCount > 0 && studentResultNode.containedSymbols && studentResultNode.containedSymbols.length > 0) {
      results.push({
        test: 'File Metadata & Contained Symbols',
        status: 'PASS',
        details: `student_result.py has ${studentResultNode.symbolsCount} symbols, language=${studentResultNode.language}, loc=${studentResultNode.loc}`
      });
    } else {
      results.push({
        test: 'File Metadata & Contained Symbols',
        status: 'FAIL',
        details: `Failed to extract file metadata: ${JSON.stringify(studentResultNode)}`
      });
    }
  } catch (err: any) {
    results.push({ test: 'File Metadata & Contained Symbols', status: 'FAIL', details: err?.message || String(err) });
  }

  // 3. Caller / Callee Relationships & CALLS edges
  try {
    const payload = engine.exportGraphData({ scope: 'full' });
    const mainNode = payload.nodes.find(n => n.type === 'symbol' && n.label.includes('main'));
    const callsEdges = payload.edges.filter(e => e.type === 'CALLS');

    if (mainNode && mainNode.callees && mainNode.callees.length > 0 && callsEdges.length > 0) {
      results.push({
        test: 'Direct Caller / Callee & CALLS Edges',
        status: 'PASS',
        details: `main() has ${mainNode.callees.length} direct callees (${mainNode.callees.map(c => c.name).join(', ')}). Total CALLS edges: ${callsEdges.length}`
      });
    } else {
      results.push({
        test: 'Direct Caller / Callee & CALLS Edges',
        status: 'FAIL',
        details: `Caller/Callee analysis failed. Main node callees: ${JSON.stringify(mainNode?.callees)}, CALLS edges: ${callsEdges.length}`
      });
    }
  } catch (err: any) {
    results.push({ test: 'Direct Caller / Callee & CALLS Edges', status: 'FAIL', details: err?.message || String(err) });
  }

  // 4. Edge Types & Filtering
  try {
    const payloadAll = engine.exportGraphData({ scope: 'full', edgeTypeFilter: 'all' });
    const payloadCalls = engine.exportGraphData({ scope: 'full', edgeTypeFilter: 'calls' });

    const hasEdgeTypes = payloadAll.edges.some(e => e.type === 'DEFINES') && payloadAll.edges.some(e => e.type === 'CALLS');
    const isFiltered = payloadCalls.edges.every(e => e.type === 'CALLS');

    if (hasEdgeTypes && isFiltered) {
      results.push({
        test: 'Semantic Edge Types & Edge Filtering',
        status: 'PASS',
        details: `Found DEFINES and CALLS edges. Edge type filter 'calls' successfully returned ${payloadCalls.edges.length} edges of type CALLS`
      });
    } else {
      results.push({
        test: 'Semantic Edge Types & Edge Filtering',
        status: 'FAIL',
        details: `Edge filtering failed. All edges: ${payloadAll.edges.length}, Calls filtered: ${payloadCalls.edges.length}`
      });
    }
  } catch (err: any) {
    results.push({ test: 'Semantic Edge Types & Edge Filtering', status: 'FAIL', details: err?.message || String(err) });
  }

  // 5. Open in Editor Location Data
  try {
    const payload = engine.exportGraphData({ scope: 'full' });
    const validateNode = payload.nodes.find(n => n.type === 'symbol' && n.label.includes('validate_marks'));

    if (validateNode && validateNode.startLine === 3 && validateNode.path) {
      results.push({
        test: 'Open in Editor Location Data',
        status: 'PASS',
        details: `validate_marks exact location verified: file=${validateNode.path}, startLine=${validateNode.startLine}, endLine=${validateNode.endLine}`
      });
    } else {
      results.push({
        test: 'Open in Editor Location Data',
        status: 'FAIL',
        details: `Location verification failed for validate_marks: ${JSON.stringify(validateNode)}`
      });
    }
  } catch (err: any) {
    results.push({ test: 'Open in Editor Location Data', status: 'FAIL', details: err?.message || String(err) });
  }

  // 6. Current Task Relevance
  try {
    const payload = engine.exportGraphData({ scope: 'current-task', targetFiles: ['src/sandbox/student_result.py'], activeFile: 'src/sandbox/student_result.py' });
    const targetNode = payload.nodes.find(n => n.id.includes('student_result.py'));

    if (targetNode && targetNode.taskRelevance && targetNode.taskRelevance.isRelevant && targetNode.taskRelevance.reasons.length > 0) {
      results.push({
        test: 'Current Task Relevance & Structural Reasons',
        status: 'PASS',
        details: `student_result.py task relevance verified: isRelevant=true, reasons=[${targetNode.taskRelevance.reasons.join('; ')}]`
      });
    } else {
      results.push({
        test: 'Current Task Relevance & Structural Reasons',
        status: 'FAIL',
        details: `Task relevance failed: ${JSON.stringify(targetNode?.taskRelevance)}`
      });
    }
  } catch (err: any) {
    results.push({ test: 'Current Task Relevance & Structural Reasons', status: 'FAIL', details: err?.message || String(err) });
  }

  // 7. Related Test Detection
  try {
    const payload = engine.exportGraphData({ scope: 'full' });
    const fileNode = payload.nodes.find(n => n.type === 'file' && n.id.includes('student_result.py'));

    if (fileNode && fileNode.relatedTests) {
      results.push({
        test: 'Related Test Suite Detection',
        status: 'PASS',
        details: `Related test detection completed. Found ${fileNode.relatedTests.length} tests associated with student_result.py`
      });
    } else {
      results.push({
        test: 'Related Test Suite Detection',
        status: 'FAIL',
        details: 'Related test array missing from file node'
      });
    }
  } catch (err: any) {
    results.push({ test: 'Related Test Suite Detection', status: 'FAIL', details: err?.message || String(err) });
  }

  // 8. Impact Analysis & Trace Path
  try {
    const payload = engine.exportGraphData({ scope: 'full' });
    const mainSymbolNode = payload.nodes.find(n => n.type === 'symbol' && n.label.includes('main')) || payload.nodes[0];
    const impact = engine.getImpactAnalysis(mainSymbolNode.id, payload);

    const valNode = payload.nodes.find(n => n.type === 'symbol' && n.label.includes('validate_marks'));
    const pathTrace = (mainSymbolNode && valNode) ? engine.tracePath(mainSymbolNode.id, valNode.id, payload) : null;

    if (impact && impact.nodeId && pathTrace) {
      results.push({
        test: 'Dependency Impact Analysis & Trace Path',
        status: 'PASS',
        details: `Impact: directDeps=${impact.directDependenciesCount}, directDependents=${impact.directDependentsCount}. Path from main to validate_marks: ${pathTrace.map(p => p.label).join(' -> ')}`
      });
    } else {
      results.push({
        test: 'Dependency Impact Analysis & Trace Path',
        status: 'FAIL',
        details: `Impact analysis or path tracing failed: impact=${JSON.stringify(impact)}, pathTrace=${JSON.stringify(pathTrace)}`
      });
    }
  } catch (err: any) {
    results.push({ test: 'Dependency Impact Analysis & Trace Path', status: 'FAIL', details: err?.message || String(err) });
  }

  // 9. Existing Scopes & Backward Compatibility
  try {
    const scopeTask = engine.exportGraphData({ scope: 'current-task' });
    const scopeGen = engine.exportGraphData({ scope: 'generated' });
    const scopeDeps = engine.exportGraphData({ scope: 'dependencies' });
    const scopeFull = engine.exportGraphData({ scope: 'full' });

    if (scopeTask && scopeGen && scopeDeps && scopeFull && scopeFull.nodes.length >= scopeTask.nodes.length) {
      results.push({
        test: 'Graphify Scopes & Backward Compatibility',
        status: 'PASS',
        details: `All 4 scopes exported valid graph payloads: current-task (${scopeTask.nodes.length} nodes), generated (${scopeGen.nodes.length}), dependencies (${scopeDeps.nodes.length}), full (${scopeFull.nodes.length})`
      });
    } else {
      results.push({
        test: 'Graphify Scopes & Backward Compatibility',
        status: 'FAIL',
        details: 'Scope export validation failed'
      });
    }
  } catch (err: any) {
    results.push({ test: 'Graphify Scopes & Backward Compatibility', status: 'FAIL', details: err?.message || String(err) });
  }

  const allPassed = results.every(r => r.status === 'PASS');
  return { passed: allPassed, results };
}
