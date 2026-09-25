import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { permissionGate } from '../tools/permissionGate';
import { kaizenMCPServer } from './mcpServer';
import * as path from 'path';
import * as fs from 'fs';

export interface MCPActionResult {
  success: boolean;
  tool: 'filesystem' | 'git' | 'terminal' | 'browser';
  action: string;
  output: string;
  error?: string;
  riskScore: number;
  isSimulated?: boolean;
  approvalStatus?: 'APPROVED' | 'REJECTED' | 'PENDING_APPROVAL' | 'AUTO_APPROVED';
  confirmation?: string;
  requestedAction?: string;
}

export interface GitActionOptions {
  dryRun?: boolean;
  approved?: boolean;
}

export type MCPServerTransportType = 'in_process' | 'stdio';

export interface MCPServerConfig {
  id: string;
  name: string;
  transportType: MCPServerTransportType;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

export class MCPUnifiedInterface {
  private mcpClient: Client | null = null;
  private activeTransport: any = null;
  private isConnected: boolean = false;
  private connectionPromise: Promise<void> | null = null;
  private activeConfig: MCPServerConfig | null = null;
  private serverConfigs: Map<string, MCPServerConfig> = new Map();
  private discoveredTools: Map<string, any> = new Map();

  constructor() {
    // Register default built-in server configurations
    this.registerServerConfig({
      id: 'default-inprocess',
      name: 'Kaizen Local In-Process MCP Server',
      transportType: 'in_process'
    });

    const cliPath = path.resolve(process.cwd(), 'dist/mcp/mcpServerCli.js');
    this.registerServerConfig({
      id: 'default-stdio',
      name: 'Kaizen External Stdio Process MCP Server',
      transportType: 'stdio',
      command: 'node',
      args: [cliPath]
    });

    const playwrightCliPath = path.resolve(process.cwd(), 'node_modules/@playwright/mcp/cli.js');
    if (fs.existsSync(playwrightCliPath)) {
      this.registerServerConfig({
        id: 'playwright-mcp-stdio',
        name: 'External Playwright MCP Server Process',
        transportType: 'stdio',
        command: 'node',
        args: [playwrightCliPath, '--headless']
      });
    } else {
      this.registerServerConfig({
        id: 'playwright-mcp-stdio',
        name: 'External Playwright MCP Server Process',
        transportType: 'stdio',
        command: 'npx',
        args: ['-y', '@playwright/mcp@latest', '--headless']
      });
    }
  }

  /**
   * Registers a configurable MCP server definition
   */
  public registerServerConfig(config: MCPServerConfig): void {
    this.serverConfigs.set(config.id, config);
  }

  /**
   * Returns all registered MCP server configurations
   */
  public getServerConfigs(): MCPServerConfig[] {
    return Array.from(this.serverConfigs.values());
  }

  /**
   * Returns current active connection status
   */
  public getConnectionStatus(): { isConnected: boolean; serverId?: string; serverName?: string; transportType?: string } {
    return {
      isConnected: this.isConnected,
      serverId: this.activeConfig?.id,
      serverName: this.activeConfig?.name,
      transportType: this.activeConfig?.transportType
    };
  }

  /**
   * Connects the MCP Client to a specific MCP server definition
   */
  public async connectServer(target?: MCPServerConfig | string): Promise<void> {
    let configToConnect: MCPServerConfig;

    if (!target) {
      configToConnect = this.activeConfig || this.serverConfigs.get('default-inprocess')!;
    } else if (typeof target === 'string') {
      const found = this.serverConfigs.get(target);
      if (!found) throw new Error(`MCP Server Config with ID "${target}" not found.`);
      configToConnect = found;
    } else {
      configToConnect = target;
      this.registerServerConfig(configToConnect);
    }

    if (this.isConnected) {
      await this.disconnectServer();
    }

    this.connectionPromise = (async () => {
      try {
        console.log(`[MCPClient] Connecting to MCP Server "${configToConnect.name}" via ${configToConnect.transportType.toUpperCase()} transport...`);

        this.mcpClient = new Client(
          {
            name: 'kaizen-mcp-client',
            version: '1.0.0'
          },
          { capabilities: {} }
        );

        if (configToConnect.transportType === 'stdio') {
          const command = configToConnect.command || 'node';
          const args = configToConnect.args || [];
          const env = { ...process.env, ...(configToConnect.env || {}) };

          const transport = new StdioClientTransport({
            command,
            args,
            env: env as Record<string, string>
          });

          this.activeTransport = transport;
          await this.mcpClient.connect(transport);
        } else {
          const { clientTransport } = await kaizenMCPServer.connectTransportPair();
          this.activeTransport = clientTransport;
          await this.mcpClient.connect(clientTransport);
        }

        this.activeConfig = configToConnect;
        this.isConnected = true;

        await this.discoverTools();
        console.log(`[MCPClient] Connected cleanly to "${configToConnect.name}". Discovered ${this.discoveredTools.size} dynamic tools.`);
      } catch (err) {
        console.error(`[MCPClient] Connection to server "${configToConnect.name}" failed:`, err);
        this.isConnected = false;
        this.mcpClient = null;
        this.activeTransport = null;
        this.connectionPromise = null;
        throw err;
      }
    })();

    return this.connectionPromise;
  }

  /**
   * Disconnects active MCP Client transport cleanly
   */
  public async disconnectServer(): Promise<void> {
    if (!this.isConnected && !this.mcpClient) return;

    try {
      if (this.mcpClient) {
        await this.mcpClient.close();
      }
      if (this.activeTransport && typeof this.activeTransport.close === 'function') {
        await this.activeTransport.close();
      }
      console.log(`[MCPClient] Disconnected from server "${this.activeConfig?.name || 'unknown'}".`);
    } catch (err) {
      console.warn('[MCPClient] Error during disconnect:', err);
    } finally {
      this.isConnected = false;
      this.mcpClient = null;
      this.activeTransport = null;
      this.activeConfig = null;
      this.connectionPromise = null;
      this.discoveredTools.clear();
    }
  }

  /**
   * Ensures the MCP Client is connected to an active server
   */
  public async ensureConnected(): Promise<void> {
    if (this.isConnected && this.mcpClient) return;
    if (this.connectionPromise) return this.connectionPromise;
    return this.connectServer('default-inprocess');
  }

  /**
   * Dynamically query available tools from the connected MCP Server over protocol
   */
  public async discoverTools(): Promise<any[]> {
    if (!this.mcpClient) return [];
    try {
      const response = await this.mcpClient.listTools();
      const tools = response.tools || [];
      this.discoveredTools.clear();
      for (const tool of tools) {
        this.discoveredTools.set(tool.name, tool);
      }
      return tools;
    } catch (err) {
      console.error('[MCPClient] Failed to discover tools from connected server:', err);
      return [];
    }
  }

  /**
   * Returns list of cached discovered MCP tool definitions
   */
  public getDiscoveredTools(): any[] {
    return Array.from(this.discoveredTools.values());
  }

  /**
   * Execute an arbitrary MCP tool by name after passing PermissionGate
   */
  public async callMCPTool(toolName: string, args: Record<string, any> = {}, options?: GitActionOptions): Promise<MCPActionResult> {
    await this.ensureConnected();

    const evalResult = permissionGate.evaluate(toolName, args);
    const isDryRun = options?.dryRun ?? permissionGate.isDryRunMode();

    if (isDryRun) {
      return {
        success: options?.approved !== false,
        tool: 'terminal',
        action: toolName,
        output: options?.approved === false ? `SIMULATED ${toolName.toUpperCase()} DENIED` : `SIMULATED ${toolName.toUpperCase()} APPROVED`,
        riskScore: evalResult.riskScore,
        isSimulated: true,
        approvalStatus: options?.approved === false ? 'REJECTED' : (options?.approved ? 'APPROVED' : 'PENDING_APPROVAL'),
        requestedAction: toolName
      };
    }

    if (evalResult.requiresApproval && !evalResult.allowed && options?.approved !== true) {
      return {
        success: false,
        tool: 'terminal',
        action: toolName,
        output: '',
        error: `Permission Gate Blocked: ${evalResult.reason}`,
        riskScore: evalResult.riskScore,
        approvalStatus: 'PENDING_APPROVAL',
        requestedAction: toolName
      };
    }

    try {
      const result: any = await this.mcpClient!.callTool({
        name: toolName,
        arguments: args
      });

      const textOutput = result.content?.map((c: any) => typeof c === 'string' ? c : (c.text || JSON.stringify(c))).join('\n') || '';
      const isError = Boolean(result.isError);

      return {
        success: !isError,
        tool: 'terminal',
        action: toolName,
        output: textOutput,
        error: isError ? textOutput : undefined,
        riskScore: evalResult.riskScore,
        approvalStatus: options?.approved ? 'APPROVED' : 'AUTO_APPROVED',
        requestedAction: toolName
      };
    } catch (err: any) {
      return {
        success: false,
        tool: 'terminal',
        action: toolName,
        output: '',
        error: err?.message || String(err),
        riskScore: evalResult.riskScore
      };
    }
  }

  /**
   * Browser Action Controller (connects to Playwright MCP process if needed and dispatches tool call)
   */
  public async executeBrowserAction(
    action: 'navigate' | 'snapshot' | 'click' | 'type' | 'fill' | 'press' | 'select' | 'hover' | 'evaluate',
    params: { url?: string; selector?: string; text?: string; script?: string; element?: string; ref?: string; name?: string } = {},
    options?: GitActionOptions
  ): Promise<MCPActionResult> {
    const evalResult = permissionGate.evaluate(`browser_${action}`, params);
    const isDryRun = options?.dryRun ?? permissionGate.isDryRunMode();

    if (isDryRun) {
      return {
        success: options?.approved !== false,
        tool: 'browser',
        action: `browser_${action}`,
        output: options?.approved === false ? `SIMULATED BROWSER ${action.toUpperCase()} DENIED` : `SIMULATED BROWSER ${action.toUpperCase()} APPROVED`,
        riskScore: evalResult.riskScore,
        isSimulated: true,
        approvalStatus: options?.approved === false ? 'REJECTED' : (options?.approved ? 'APPROVED' : 'PENDING_APPROVAL'),
        requestedAction: `browser_${action}`
      };
    }

    if (evalResult.requiresApproval && !evalResult.allowed && options?.approved !== true) {
      return {
        success: false,
        tool: 'browser',
        action: `browser_${action}`,
        output: '',
        error: `Permission Gate Blocked: ${evalResult.reason}`,
        riskScore: evalResult.riskScore,
        approvalStatus: 'PENDING_APPROVAL',
        requestedAction: `browser_${action}`
      };
    }

    // Connect to external Playwright MCP server if not already on a browser-capable server
    try {
      if (!this.isConnected || (this.activeConfig?.id !== 'playwright-mcp-stdio' && !this.discoveredTools.has('browser_navigate') && !this.discoveredTools.has('browser_snapshot') && !this.discoveredTools.has('navigate'))) {
        await this.connectServer('playwright-mcp-stdio');
      }
    } catch (err) {
      console.warn('[MCPClient] Playwright MCP server failed to connect, falling back to in-process browser simulation:', err);
      await this.connectServer('default-inprocess');
    }

    // Find actual tool name in discovered tools matching the action
    let targetToolName = `browser_${action}`;
    if (!this.discoveredTools.has(targetToolName)) {
      if (this.discoveredTools.has(action)) {
        targetToolName = action;
      } else {
        for (const [tName] of this.discoveredTools.entries()) {
          if (tName.toLowerCase().includes(action)) {
            targetToolName = tName;
            break;
          }
        }
      }
    }

    let toolArgs: Record<string, any> = {};
    if (action === 'navigate') {
      toolArgs = { url: params.url || 'http://localhost:3000' };
    } else if (action === 'snapshot') {
      toolArgs = {};
    } else if (action === 'click') {
      const targetRef = params.ref || params.element || params.selector || params.name || '';
      toolArgs = { selector: targetRef, element: targetRef, ref: targetRef };
    } else if (action === 'type' || action === 'fill') {
      const targetRef = params.ref || params.element || params.selector || params.name || '';
      toolArgs = { selector: targetRef, element: targetRef, text: params.text || '' };
    } else if (action === 'hover') {
      const targetRef = params.ref || params.element || params.selector || params.name || '';
      toolArgs = { selector: targetRef, element: targetRef };
    } else if (action === 'evaluate') {
      toolArgs = { script: params.script || '' };
    } else {
      toolArgs = { ...params };
    }

    try {
      const result: any = await this.mcpClient!.callTool({
        name: targetToolName,
        arguments: toolArgs
      });

      const textOutput = result.content?.map((c: any) => typeof c === 'string' ? c : (c.text || JSON.stringify(c))).join('\n') || '';
      const isError = Boolean(result.isError);

      return {
        success: !isError,
        tool: 'browser',
        action: `browser_${action}`,
        output: textOutput || `Browser ${action} executed cleanly.`,
        error: isError ? textOutput : undefined,
        riskScore: evalResult.riskScore,
        approvalStatus: options?.approved ? 'APPROVED' : 'AUTO_APPROVED',
        requestedAction: `browser_${action}`
      };
    } catch (err: any) {
      return {
        success: false,
        tool: 'browser',
        action: `browser_${action}`,
        output: '',
        error: err?.message || String(err),
        riskScore: evalResult.riskScore,
        approvalStatus: options?.approved ? 'APPROVED' : 'AUTO_APPROVED',
        requestedAction: `browser_${action}`
      };
    }
  }

  /**
   * Filesystem Controller (dispatches via MCP Client callTool over active transport)
   */
  public async executeFilesystemAction(
    action: 'read' | 'write' | 'list' | 'delete',
    relPath: string,
    content?: string,
    options?: GitActionOptions
  ): Promise<MCPActionResult> {
    const evalResult = permissionGate.evaluate(`filesystem_${action}`, { path: relPath, content });
    const isDryRun = options?.dryRun ?? permissionGate.isDryRunMode();
    const isMutatingAction = action === 'write' || action === 'delete';

    if (isDryRun && isMutatingAction) {
      if (options?.approved === false) {
        return {
          success: false,
          tool: 'filesystem',
          action: `filesystem_${action}`,
          output: `SIMULATED FILESYSTEM ${action.toUpperCase()} DENIED — execution aborted`,
          error: `Permission Gate Blocked: ${evalResult.reason}`,
          riskScore: evalResult.riskScore,
          isSimulated: true,
          approvalStatus: 'REJECTED',
          requestedAction: action,
          confirmation: 'No filesystem operation was executed.'
        };
      }

      if (options?.approved === true) {
        return {
          success: true,
          tool: 'filesystem',
          action: `filesystem_${action}`,
          output: `SIMULATED FILESYSTEM ${action.toUpperCase()} APPROVED — no filesystem changes made`,
          riskScore: evalResult.riskScore,
          isSimulated: true,
          approvalStatus: 'APPROVED',
          requestedAction: action,
          confirmation: 'No filesystem operation was executed in dry-run mode.'
        };
      }

      return {
        success: false,
        tool: 'filesystem',
        action: `filesystem_${action}`,
        output: '',
        error: `Permission Gate Intercepted: ${evalResult.reason}`,
        riskScore: evalResult.riskScore,
        isSimulated: true,
        approvalStatus: 'PENDING_APPROVAL',
        requestedAction: action,
        confirmation: 'No filesystem operation was executed.'
      };
    }

    if (evalResult.requiresApproval && !evalResult.allowed && options?.approved !== true) {
      return {
        success: false,
        tool: 'filesystem',
        action: `filesystem_${action}`,
        output: '',
        error: `Permission Gate Blocked: ${evalResult.reason}`,
        riskScore: evalResult.riskScore,
        approvalStatus: 'PENDING_APPROVAL',
        requestedAction: action
      };
    }

    await this.ensureConnected();

    const toolName = `filesystem_${action}`;
    const toolArgs = { relPath, content };

    try {
      const result: any = await this.mcpClient!.callTool({
        name: toolName,
        arguments: toolArgs
      });

      const textOutput = result.content?.map((c: any) => typeof c === 'string' ? c : (c.text || JSON.stringify(c))).join('\n') || '';
      const isError = Boolean(result.isError);

      return {
        success: !isError,
        tool: 'filesystem',
        action: action === 'read' || action === 'write' || action === 'list' || action === 'delete' ? action : `filesystem_${action}`,
        output: textOutput,
        error: isError ? textOutput : undefined,
        riskScore: evalResult.riskScore
      };
    } catch (err: any) {
      return {
        success: false,
        tool: 'filesystem',
        action: action === 'read' || action === 'write' || action === 'list' || action === 'delete' ? action : `filesystem_${action}`,
        output: '',
        error: err?.message || String(err),
        riskScore: evalResult.riskScore
      };
    }
  }

  /**
   * Git Controller (dispatches via MCP Client callTool over active transport)
   */
  public async executeGitAction(
    action: 'status' | 'diff' | 'commit' | 'push' | 'log',
    message?: string,
    options?: GitActionOptions
  ): Promise<MCPActionResult> {
    const evalResult = permissionGate.evaluate(`git_${action}`, { message, command: `git ${action}` });
    const isDryRun = options?.dryRun ?? permissionGate.isDryRunMode();
    const isMutatingAction = action === 'commit' || action === 'push';

    if (isDryRun && isMutatingAction) {
      if (options?.approved === false) {
        return {
          success: false,
          tool: 'git',
          action: `git_${action}`,
          output: `SIMULATED ${action.toUpperCase()} DENIED — execution aborted`,
          error: `Permission Gate Blocked: ${evalResult.reason}`,
          riskScore: evalResult.riskScore,
          isSimulated: true,
          approvalStatus: 'REJECTED',
          requestedAction: action,
          confirmation: 'No Git command was executed.'
        };
      }

      return {
        success: true,
        tool: 'git',
        action: `git_${action}`,
        output: `SIMULATED ${action.toUpperCase()} APPROVED — no repository changes made`,
        riskScore: evalResult.riskScore,
        isSimulated: true,
        approvalStatus: 'APPROVED',
        requestedAction: action,
        confirmation: 'No Git command was executed in dry-run mode.'
      };
    }

    if (evalResult.requiresApproval && !evalResult.allowed && options?.approved !== true) {
      return {
        success: false,
        tool: 'git',
        action: `git_${action}`,
        output: '',
        error: `Permission Gate Blocked: ${evalResult.reason}`,
        riskScore: evalResult.riskScore,
        approvalStatus: 'PENDING_APPROVAL',
        requestedAction: action
      };
    }

    await this.ensureConnected();

    const toolName = `git_${action}`;
    const toolArgs = { message };

    try {
      const result: any = await this.mcpClient!.callTool({
        name: toolName,
        arguments: toolArgs
      });

      const textOutput = result.content?.map((c: any) => typeof c === 'string' ? c : (c.text || JSON.stringify(c))).join('\n') || '';
      const isError = Boolean(result.isError);

      return {
        success: !isError,
        tool: 'git',
        action: `git_${action}`,
        output: textOutput || 'Git command executed successfully.',
        error: isError ? textOutput : undefined,
        riskScore: evalResult.riskScore,
        approvalStatus: options?.approved ? 'APPROVED' : 'AUTO_APPROVED',
        requestedAction: action
      };
    } catch (err: any) {
      return {
        success: false,
        tool: 'git',
        action: `git_${action}`,
        output: '',
        error: err?.message || String(err),
        riskScore: evalResult.riskScore,
        approvalStatus: options?.approved ? 'APPROVED' : 'AUTO_APPROVED',
        requestedAction: action
      };
    }
  }

  /**
   * Terminal Controller (dispatches via MCP Client callTool over active transport)
   */
  public async executeTerminalCommand(
    command: string,
    cwd: string = process.cwd(),
    options?: GitActionOptions
  ): Promise<MCPActionResult> {
    const trimmedCmd = (command || '').trim();
    if (!trimmedCmd || /^(execution|permission gate|command result|status|error|\[automated test)/i.test(trimmedCmd)) {
      return {
        success: false,
        tool: 'terminal',
        action: 'terminal_exec',
        output: '',
        error: `TOOL_EXECUTION_FAILURE: Invalid shell command '${command}'. Status headers or empty strings cannot be executed as a command.`,
        riskScore: 100,
        isSimulated: false,
        approvalStatus: 'REJECTED',
        requestedAction: 'terminal_exec'
      };
    }

    const evalResult = permissionGate.evaluate('terminal_exec', { command: trimmedCmd });
    const isDryRun = options?.dryRun ?? permissionGate.isDryRunMode();

    if (isDryRun || permissionGate.isDryRunMode()) {
      if (options?.approved === false) {
        return {
          success: false,
          tool: 'terminal',
          action: 'terminal_exec',
          output: 'SIMULATED TERMINAL EXECUTION DENIED — execution aborted',
          error: `Permission Gate Blocked: ${evalResult.reason}`,
          riskScore: evalResult.riskScore,
          isSimulated: true,
          approvalStatus: 'REJECTED',
          requestedAction: 'terminal_exec',
          confirmation: 'No terminal command was executed.'
        };
      }

      if (options?.approved === true) {
        return {
          success: true,
          tool: 'terminal',
          action: 'terminal_exec',
          output: 'SIMULATED TERMINAL EXECUTION APPROVED — no process spawned',
          riskScore: evalResult.riskScore,
          isSimulated: true,
          approvalStatus: 'APPROVED',
          requestedAction: 'terminal_exec',
          confirmation: 'No terminal command was executed in dry-run mode.'
        };
      }

      return {
        success: false,
        tool: 'terminal',
        action: 'terminal_exec',
        output: '',
        error: `Permission Gate Intercepted: ${evalResult.reason}`,
        riskScore: evalResult.riskScore,
        isSimulated: true,
        approvalStatus: 'PENDING_APPROVAL',
        requestedAction: 'terminal_exec',
        confirmation: 'No terminal command was executed.'
      };
    }

    if (evalResult.requiresApproval && !evalResult.allowed && options?.approved !== true) {
      return {
        success: false,
        tool: 'terminal',
        action: 'terminal_exec',
        output: '',
        error: `Permission Gate Blocked: ${evalResult.reason}`,
        riskScore: evalResult.riskScore,
        approvalStatus: 'PENDING_APPROVAL',
        requestedAction: 'terminal_exec'
      };
    }

    await this.ensureConnected();

    try {
      const result: any = await this.mcpClient!.callTool({
        name: 'terminal_exec',
        arguments: { command, cwd }
      });

      const textOutput = result.content?.map((c: any) => typeof c === 'string' ? c : (c.text || JSON.stringify(c))).join('\n') || '';
      const isError = Boolean(result.isError);

      return {
        success: !isError,
        tool: 'terminal',
        action: 'terminal_exec',
        output: textOutput || 'Command completed successfully.',
        error: isError ? textOutput : undefined,
        riskScore: evalResult.riskScore,
        approvalStatus: options?.approved ? 'APPROVED' : 'AUTO_APPROVED',
        requestedAction: 'terminal_exec'
      };
    } catch (err: any) {
      return {
        success: false,
        tool: 'terminal',
        action: 'terminal_exec',
        output: '',
        error: err?.message || String(err),
        riskScore: evalResult.riskScore,
        approvalStatus: options?.approved ? 'APPROVED' : 'AUTO_APPROVED',
        requestedAction: 'terminal_exec'
      };
    }
  }
}

export const mcpInterface = new MCPUnifiedInterface();
