import * as path from 'path';
import * as fs from 'fs';
import { KaizenState } from '../state';
import { GraphifyEngine } from '../tools/graphifyEngine';
import { persistenceEngine } from '../tools/persistenceEngine';

export async function contextRetrievalAgentNode(state: typeof KaizenState.State) {
  let targetFiles = state.targetFiles && state.targetFiles.length > 0 
    ? state.targetFiles 
    : [];

  if (targetFiles.length === 0) {
    const sandboxDir = path.resolve(process.cwd(), 'src/sandbox');
    if (fs.existsSync(sandboxDir)) {
      const existing = fs.readdirSync(sandboxDir)
        .filter(f => fs.statSync(path.join(sandboxDir, f)).isFile() && !f.startsWith('.'))
        .map(f => `src/sandbox/${f}`);
      if (existing.length > 0) {
        targetFiles = existing;
      }
    }
  }

  if (targetFiles.length === 0) {
    targetFiles = ['src/sandbox/main.ts'];
  }

  targetFiles = targetFiles.map(f => f.replace(/\\/g, '/'));

  const engine = new GraphifyEngine();
  engine.clearCache();

  // Root workspace/sandbox directory is the single source of truth
  let workspaceRoot = 'src/sandbox';
  if (!fs.existsSync(workspaceRoot)) {
    workspaceRoot = '.';
  }

  // Safety Timeout Promise (5000ms) to ensure ContextRetrievalAgent never hangs LangGraph
  const TIMEOUT_MS = 5000;

  let extractedContext = "";
  try {
    const scanPromise = (async () => {
      // 1. Scan primary workspace root (src/sandbox)
      await engine.scanDirectory(workspaceRoot);

      // 2. Expand target files if any target file is a directory
      const expandedTargets = engine.expandTargetFiles(targetFiles);

      // 3. Assemble structured context summary
      const summary = engine.buildContextSummary(expandedTargets);

      // 4. Export structured Graphify payload for Graphify Explorer UI
      const graphPayload = engine.exportGraphData({
        scope: 'current-task',
        targetFiles: expandedTargets
      });

      // 5. Cache workspace graph summary and structured payload in Persistence Engine
      persistenceEngine.cacheWorkspaceGraph(workspaceRoot, summary, expandedTargets.length, graphPayload);

      // 5. Expand targetFiles with resolved internal workspace dependencies from Graphify Engine
      const dependencyTree = engine.getDependencyTree();
      const allTargetsWithDeps = new Set<string>(expandedTargets);
      for (const target of expandedTargets) {
        const key = engine.findMatchingKey(target);
        if (key && dependencyTree.has(key)) {
          const deps = dependencyTree.get(key) || [];
          for (const dep of deps) {
            allTargetsWithDeps.add(dep);
          }
        }
      }
      targetFiles = Array.from(allTargetsWithDeps);

      return summary;
    })();

    const timeoutPromise = new Promise<string>((_, reject) => {
      setTimeout(() => reject(new Error(`[CONTEXT][TIMEOUT] Workspace scan timed out after ${TIMEOUT_MS}ms`)), TIMEOUT_MS);
    });

    extractedContext = await Promise.race([scanPromise, timeoutPromise]);
  } catch (err: any) {
    console.warn(`[CONTEXT][WARN] Fallback context retrieval triggered:`, err?.message || err);

    // Fallback: Check if we have cached workspace graph summary
    const cachedGraph = persistenceEngine.getWorkspaceGraphCache(workspaceRoot);
    if (cachedGraph) {
      extractedContext = `=== CACHED WORKSPACE GRAPH (Saved: ${cachedGraph.timestamp}) ===\n${cachedGraph.summary}`;
    } else {
      // Read target files directly
      const fallbackList: string[] = ["=== FALLBACK WORKSPACE CONTEXT ==="];
      for (const tf of targetFiles) {
        if (fs.existsSync(tf)) {
          try {
            const stat = fs.statSync(tf);
            if (stat.isDirectory()) {
              const list = fs.readdirSync(tf);
              for (const child of list) {
                const childPath = path.join(tf, child);
                if (fs.statSync(childPath).isFile()) {
                  fallbackList.push(`--- FILE: ${childPath} ---`);
                  fallbackList.push(fs.readFileSync(childPath, 'utf-8'));
                }
              }
            } else {
              fallbackList.push(`--- FILE: ${tf} ---`);
              fallbackList.push(fs.readFileSync(tf, 'utf-8'));
            }
          } catch {
            fallbackList.push(`--- FILE: ${tf} (Error reading) ---`);
          }
        }
      }
      extractedContext = fallbackList.join('\n');
    }
  }

  console.log(`[ContextRetrievalAgent] Successfully completed workspace scan. Target files: ${targetFiles.join(', ')}`);

  return {
    targetFiles,
    extractedContext,
    status: "CONTEXT_RETRIEVED"
  };
}

