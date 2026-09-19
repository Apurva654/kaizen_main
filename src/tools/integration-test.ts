import { 
  loadProjectContext, 
  formatContextForPrompt, 
  handleContextCommand, 
  saveAgentState, 
  loadAgentState,
  recordConversationTurn,
  formatStateForPrompt
} from './context-manager';

export async function testContextIntegration() {
  console.log('🧪 Testing Context Integration\n');

  const assert = (condition: any, message: string) => {
    if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
    console.log(`✓ ${message}`);
  };

  // Test 1: Context loads
  const context = await loadProjectContext();
  assert(context.projectName, 'Project name loaded');
  assert(context.language, 'Language detected');
  assert(context.filesStructure, 'File structure built');
  assert(context.gitLog.length > 0, 'Git log loaded');

  // Test 2: Command handler works
  const commandResponse = await handleContextCommand('@context');
  assert(commandResponse.includes('PROJECT CONTEXT'), '@context command works');
  assert(commandResponse.includes('kaizen-ai'), 'Project name in response');

  // Test 3: Files command works
  const filesResponse = await handleContextCommand('@files');
  assert(filesResponse.includes('src/'), '@files command works');

  // Test 4: State persistence
  const testState = {
    conversationId: 'test-123',
    currentTask: 'test task',
    completedSteps: ['step1', 'step2'],
    generatedFiles: new Map([['test.ts', 'content']]),
    errors: [],
    timestamp: new Date()
  };
  saveAgentState(testState);
  
  const loaded = loadAgentState();
  assert(loaded !== null && loaded.conversationId === 'test-123', 'State persisted and loaded');
  assert(loaded !== null && loaded.completedSteps.length === 2, 'Steps saved correctly');

  // Test 5: Context prepended to prompt
  const formatted = formatContextForPrompt(context);
  assert(formatted.includes('PROJECT CONTEXT'), 'Context formatted');
  assert(formatted.includes('RECENT CHANGES'), 'Git log included');
  assert(formatted.includes('KEY SOURCE FILES'), 'Files included');

  // Test 6: Conversational User Facts & Turn Persistence ("my name is Jannik")
  recordConversationTurn('my name is Jannik', 'Nice to meet you, Jannik! How can I assist you today?');
  const stateWithMemory = loadAgentState();
  assert(stateWithMemory !== null && stateWithMemory.userFacts?.['Name'] === 'Jannik', 'User name "Jannik" remembered in state');
  const formattedState = formatStateForPrompt(stateWithMemory!);
  assert(formattedState.includes('Name: Jannik'), 'User name Jannik included in prompt state context');
  assert(formattedState.includes('my name is Jannik'), 'Recent conversation turn included in prompt history');

  // Test 7: General Query Intent Routing Test
  const { isGeneralQuery } = require('../agents/intentAgent');
  assert(isGeneralQuery('my name is Jannik') === true, 'General query "my name is Jannik" routed correctly');
  assert(isGeneralQuery('Whats my name?') === true, 'General query "Whats my name?" routed correctly');
  assert(isGeneralQuery('ny name?') === true, 'General query typo "ny name?" routed correctly');
  assert(isGeneralQuery('my name??') === true, 'General query "my name??" routed correctly');

  console.log('\n✅ All integration tests passed!');
}

testContextIntegration().catch(err => {
  console.error('\n❌ Integration test failed:', err.message);
  process.exit(1);
});
