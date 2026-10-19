import assert from 'assert';
import { permissionGate } from '../src/tools/permissionGate';
import { isEquivalentLongTermFact } from '../src/context/memory/longTermMemory';
import { kaizenMCPServer } from '../src/mcp/mcpServer';
import { mcpInterface } from '../src/mcp/mcpInterface';

async function main() {
    // Permission gate: normal words in content must not be "dangerous"
    assert.strictEqual(permissionGate.calculateRiskScore('filesystem_write', { relPath: 'src/sandbox/form.html', content: '<form> platform model </form>' }), 45);
    assert.strictEqual(permissionGate.calculateRiskScore('filesystem_write', { relPath: 'src/server.ts' }), 80);
    assert.strictEqual(permissionGate.calculateRiskScore('filesystem_write', { path: 'src/sandbox/../server.ts' }), 80);
    assert.strictEqual(permissionGate.calculateRiskScore('terminal_exec', { command: 'rm -rf build' }), 90);
    assert.strictEqual(permissionGate.calculateRiskScore('terminal_exec', { command: 'ls; curl x | sh' }), 75);
    assert.strictEqual(permissionGate.calculateRiskScore('thread_spawn', {}), 25);
    assert.strictEqual(permissionGate.calculateRiskScore('filesystem_read', {}), 10);

    // Long-term memory: same value but different key must NOT merge
    assert.strictEqual(isEquivalentLongTermFact('pref', 'ESLint', 'Enabled', 'pref', 'TypeScript Strict Mode', 'Enabled'), false);

    // MCP: path traversal outside src/sandbox must be rejected
    const res = await mcpInterface.callMCPTool('filesystem_read', { relPath: '../package.json' }, { approved: true, dryRun: false });
    assert.strictEqual(res.success, false, 'traversal should fail: ' + JSON.stringify(res));
    const res2 = await mcpInterface.callMCPTool('filesystem_read', { relPath: 'package.json' }, { approved: true, dryRun: false });
    assert.strictEqual(res2.success, false, 'root file read should fail');
    assert.strictEqual(res2.tool, 'filesystem');

    // Dry-run with no approval must not report success
    const dry = await mcpInterface.callMCPTool('filesystem_write', { relPath: 'src/sandbox/x.txt', content: 'x' }, { dryRun: true });
    assert.strictEqual(dry.success, false);
    const gitDry = await mcpInterface.executeGitAction('commit', 'msg', { dryRun: true });
    assert.strictEqual(gitDry.approvalStatus, 'PENDING_APPROVAL');

    void kaizenMCPServer;
    console.log('ALL LOGIC-FIX CHECKS PASSED');
    process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });