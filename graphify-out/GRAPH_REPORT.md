# Graph Report - src  (2026-10-19)

## Corpus Check
- 50 files · ~59,391 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 522 nodes · 1149 edges · 17 communities (11 shown, 6 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 9 edges (avg confidence: 0.73)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_server.ts|server.ts]]
- [[_COMMUNITY_memoryEngine.ts|memoryEngine.ts]]
- [[_COMMUNITY_debuggerAgent.ts|debuggerAgent.ts]]
- [[_COMMUNITY_KaizenBackendClient|KaizenBackendClient]]
- [[_COMMUNITY_GraphifyEngine|GraphifyEngine]]
- [[_COMMUNITY_persistenceEngine.ts|persistenceEngine.ts]]
- [[_COMMUNITY_mcpInterface.ts|mcpInterface.ts]]
- [[_COMMUNITY_modelProvider.ts|modelProvider.ts]]
- [[_COMMUNITY_contextManager.ts|contextManager.ts]]
- [[_COMMUNITY_universalValidator.ts|universalValidator.ts]]
- [[_COMMUNITY_MCPUnifiedInterface|MCPUnifiedInterface]]
- [[_COMMUNITY_PersistenceEngine|PersistenceEngine]]
- [[_COMMUNITY_GitHubAuthManager|GitHubAuthManager]]
- [[_COMMUNITY_WorkspaceManager|WorkspaceManager]]
- [[_COMMUNITY_LangfuseTracerManager|LangfuseTracerManager]]
- [[_COMMUNITY_ConversationalMemoryStore|ConversationalMemoryStore]]
- [[_COMMUNITY_WorkflowMemoryStore|WorkflowMemoryStore]]

## God Nodes (most connected - your core abstractions)
1. `runPipeline()` - 43 edges
2. `KaizenBackendClient` - 26 edges
3. `PersistenceEngine` - 25 edges
4. `LongTermMemoryManager` - 21 edges
5. `GraphifyEngine` - 21 edges
6. `intentAgentNode()` - 20 edges
7. `EpisodicMemoryManager` - 20 edges
8. `MemoryEngine` - 20 edges
9. `ShortTermMemoryManager` - 18 edges
10. `MCPUnifiedInterface` - 18 edges

## Surprising Connections (you probably didn't know these)
- `extractTargetFilesFromPrompt()` --indirect_call--> `normalizeSandboxPath()`  [INFERRED]
  agents/intentAgent.ts → tools/sandboxPathUtils.ts
- `intentAgentNode()` --calls--> `deriveTargetFile()`  [INFERRED]
  agents/intentAgent.ts → tools/languageResolver.ts
- `intentAgentNode()` --calls--> `resolveLanguage()`  [INFERRED]
  agents/intentAgent.ts → tools/languageResolver.ts
- `intentAgentNode()` --indirect_call--> `normalizeSandboxPath()`  [INFERRED]
  agents/intentAgent.ts → tools/sandboxPathUtils.ts
- `runPipeline()` --calls--> `generateFilteredResponse()`  [INFERRED]
  server.ts → agents/responseFilterAgent.ts

## Import Cycles
- None detected.

## Communities (17 total, 6 thin omitted)

### Community 0 - "server.ts"
Cohesion: 0.06
Nodes (60): GeneratedFilePatch, detectRequestedLanguageExtension(), escapeRegExp(), extractBrowserUrl(), extractGitActions(), extractRawUserPrompt(), extractTargetFilesFromPrompt(), extractTerminalCommand() (+52 more)

### Community 1 - "memoryEngine.ts"
Cohesion: 0.08
Nodes (19): EpisodicMemoryManager, isEquivalentLongTermFact(), LongTermMemoryManager, normalizeMemoryText(), MemoryConsolidator, MemoryEngine, MemoryRetriever, RetrievalQuery (+11 more)

### Community 2 - "debuggerAgent.ts"
Cohesion: 0.10
Nodes (40): codeGenAgentNode(), CodeGenSchema, EMPTY_ALLOWED_FILES, FilePatchSchema, getLanguageFromPath(), isEmptyAllowed(), sanitizeCodePatch(), saveFilePatchesToServerDiskWithVerification() (+32 more)

### Community 3 - "KaizenBackendClient"
Cohesion: 0.08
Nodes (11): BackendStreamEvent, ConnectionState, ConnectionStateChangeHandler, HealthStatus, HitlResponseParams, KaizenBackendClient, PipelineRunParams, PipelineRunResponse (+3 more)

### Community 4 - "GraphifyEngine"
Cohesion: 0.09
Nodes (20): contextRetrievalAgentNode(), extractSymbolsFromWorkspace(), ASTParserTool, ExtractedSymbol, ExtractedSymbolParameter, ALLOWED_EXTENSIONS, DependencyEdge, FileNodeFacts (+12 more)

### Community 5 - "persistenceEngine.ts"
Cohesion: 0.08
Nodes (17): StateMemoryRecord, StateMemoryManager, ChatTurn, conversationalMemory, projectMemory, ProjectMemoryStore, ProjectMetadata, StructuralGraphCache (+9 more)

### Community 6 - "mcpInterface.ts"
Cohesion: 0.09
Nodes (13): ActiveServerSession, GitActionOptions, MCPActionResult, mcpInterface, MCPServerConfig, MCPServerTransportType, KaizenMCPServer, MCPToolDefinition (+5 more)

### Community 7 - "modelProvider.ts"
Cohesion: 0.12
Nodes (22): ContextSufficiencyResult, evaluateContextSufficiency(), evaluateContextSufficiencyFallback(), EnhancedPromptResult, enhanceUserPrompt(), isVagueOrShortPrompt(), fallbackRelevanceFilter(), generateFilteredResponse() (+14 more)

### Community 8 - "contextManager.ts"
Cohesion: 0.11
Nodes (14): ContextManager, FileTree, formatContextForPrompt(), formatStateForPrompt(), handleContextCommand(), handleSpecialCommand(), listAllProjectFiles(), loadAgentState() (+6 more)

### Community 9 - "universalValidator.ts"
Cohesion: 0.11
Nodes (23): BrowserSmokeError, BrowserSmokeTestResult, parseStackFrame(), resolveStaticServer(), runBrowserSmokeTest(), extractFailingFilesFromLogs(), isBrowserProject(), runWorkspaceTests() (+15 more)

### Community 12 - "GitHubAuthManager"
Cohesion: 0.24
Nodes (4): execAsync, GitHubAuthManager, GitHubAuthStatus, GitHubUserProfile

## Knowledge Gaps
- **70 isolated node(s):** `CodeGenSchema`, `ContextSufficiencyResult`, `DebuggerSchema`, `DebuggerResult`, `PlannerStepSchema` (+65 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **6 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `runPipeline()` connect `server.ts` to `debuggerAgent.ts`, `GraphifyEngine`, `persistenceEngine.ts`, `modelProvider.ts`, `contextManager.ts`, `universalValidator.ts`?**
  _High betweenness centrality (0.001) - this node is a cross-community bridge._
- **Why does `MemoryEngine` connect `memoryEngine.ts` to `persistenceEngine.ts`?**
  _High betweenness centrality (0.001) - this node is a cross-community bridge._
- **Are the 3 inferred relationships involving `runPipeline()` (e.g. with `generateFilteredResponse()` and `prepareDiffCards()`) actually correct?**
  _`runPipeline()` has 3 INFERRED edges - model-reasoned connections that need verification._
- **What connects `CodeGenSchema`, `ContextSufficiencyResult`, `DebuggerSchema` to the rest of the system?**
  _70 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `server.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.055905220288781934 - nodes in this community are weakly interconnected._
- **Should `memoryEngine.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.07743271221532091 - nodes in this community are weakly interconnected._
- **Should `debuggerAgent.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.09948979591836735 - nodes in this community are weakly interconnected._