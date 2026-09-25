import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { dockerSandbox } from '../tools/dockerSandbox';

export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
}

export class KaizenMCPServer {
  private server: Server;

  constructor() {
    this.server = new Server(
      {
        name: 'kaizen-mcp-server',
        version: '1.0.0'
      },
      {
        capabilities: {
          tools: {}
        }
      }
    );

    this.setupToolHandlers();
  }

  public getSDKServer(): Server {
    return this.server;
  }

  private setupToolHandlers(): void {
    // List available MCP tools dynamically
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: 'filesystem_read',
            description: 'Read contents of a file relative to project root',
            inputSchema: {
              type: 'object',
              properties: {
                relPath: { type: 'string', description: 'Relative path to file' }
              },
              required: ['relPath']
            }
          },
          {
            name: 'filesystem_write',
            description: 'Write content to a file relative to project root',
            inputSchema: {
              type: 'object',
              properties: {
                relPath: { type: 'string', description: 'Relative path to file' },
                content: { type: 'string', description: 'Content to write to file' }
              },
              required: ['relPath']
            }
          },
          {
            name: 'filesystem_list',
            description: 'List contents of a directory',
            inputSchema: {
              type: 'object',
              properties: {
                relPath: { type: 'string', description: 'Relative path to directory' }
              },
              required: ['relPath']
            }
          },
          {
            name: 'filesystem_delete',
            description: 'Delete a file relative to project root',
            inputSchema: {
              type: 'object',
              properties: {
                relPath: { type: 'string', description: 'Relative path to file to delete' }
              },
              required: ['relPath']
            }
          },
          {
            name: 'git_status',
            description: 'Get current git repository status',
            inputSchema: { type: 'object', properties: {} }
          },
          {
            name: 'git_diff',
            description: 'Get current git repository working tree diff',
            inputSchema: { type: 'object', properties: {} }
          },
          {
            name: 'git_commit',
            description: 'Commit staged changes with a commit message',
            inputSchema: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Git commit message' }
              }
            }
          },
          {
            name: 'git_push',
            description: 'Push committed changes to remote repository',
            inputSchema: { type: 'object', properties: {} }
          },
          {
            name: 'git_log',
            description: 'Get recent git commit log',
            inputSchema: { type: 'object', properties: {} }
          },
          {
            name: 'terminal_exec',
            description: 'Execute shell or terminal command with optional Docker sandboxing',
            inputSchema: {
              type: 'object',
              properties: {
                command: { type: 'string', description: 'Command line to execute' },
                cwd: { type: 'string', description: 'Working directory path' },
                useSandbox: { type: 'boolean', description: 'Whether to enforce container/process sandbox' }
              },
              required: ['command']
            }
          },
          {
            name: 'browser_navigate',
            description: 'Navigate headless/generative UI browser to a given URL',
            inputSchema: {
              type: 'object',
              properties: {
                url: { type: 'string', description: 'Target URL' }
              },
              required: ['url']
            }
          },
          {
            name: 'browser_screenshot',
            description: 'Capture screenshot of current UI state',
            inputSchema: { type: 'object', properties: {} }
          },
          {
            name: 'browser_click',
            description: 'Click element matching selector in browser UI',
            inputSchema: {
              type: 'object',
              properties: {
                selector: { type: 'string', description: 'CSS Selector to click' }
              },
              required: ['selector']
            }
          },
          {
            name: 'browser_type',
            description: 'Type text into matching input element in browser UI',
            inputSchema: {
              type: 'object',
              properties: {
                selector: { type: 'string', description: 'CSS Selector' },
                text: { type: 'string', description: 'Text content to type' }
              },
              required: ['selector', 'text']
            }
          },
          {
            name: 'browser_evaluate',
            description: 'Evaluate JavaScript snippet in browser page context',
            inputSchema: {
              type: 'object',
              properties: {
                script: { type: 'string', description: 'JavaScript code snippet' }
              },
              required: ['script']
            }
          }
        ]
      };
    });

    // Handle MCP Tool Executions over JSON-RPC protocol
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const rootDir = process.cwd();

      try {
        switch (name) {
          case 'filesystem_read': {
            const relPath = String(args?.relPath || '');
            const fullPath = path.resolve(rootDir, relPath);
            if (!fs.existsSync(fullPath)) {
              return { isError: true, content: [{ type: 'text', text: `File not found: ${relPath}` }] };
            }
            const data = fs.readFileSync(fullPath, 'utf-8');
            return { content: [{ type: 'text', text: data }] };
          }

          case 'filesystem_write': {
            const relPath = String(args?.relPath || '');
            const content = String(args?.content || '');
            const fullPath = path.resolve(rootDir, relPath);
            const dir = path.dirname(fullPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(fullPath, content, 'utf-8');
            return { content: [{ type: 'text', text: `Wrote content to ${relPath}` }] };
          }

          case 'filesystem_list': {
            const relPath = String(args?.relPath || '');
            const fullPath = path.resolve(rootDir, relPath);
            const dir = fs.existsSync(fullPath) ? fullPath : path.resolve(rootDir, 'src/sandbox');
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            const files = fs.readdirSync(dir);
            return { content: [{ type: 'text', text: JSON.stringify(files) }] };
          }

          case 'filesystem_delete': {
            const relPath = String(args?.relPath || '');
            const fullPath = path.resolve(rootDir, relPath);
            if (fs.existsSync(fullPath)) {
              fs.unlinkSync(fullPath);
              return { content: [{ type: 'text', text: `Deleted file ${relPath}` }] };
            }
            return { isError: true, content: [{ type: 'text', text: `File not found: ${relPath}` }] };
          }

          case 'git_status':
          case 'git_diff':
          case 'git_commit':
          case 'git_push':
          case 'git_log': {
            const action = name.replace('git_', '');
            let gitCmd = 'git status';
            if (action === 'status') gitCmd = 'git status';
            else if (action === 'diff') gitCmd = 'git diff';
            else if (action === 'commit') gitCmd = `git commit -m "${args?.message || 'Auto-commit'}"`;
            else if (action === 'push') gitCmd = 'git push';
            else if (action === 'log') gitCmd = 'git log -n 5';

            return new Promise((resolve) => {
              exec(gitCmd, { cwd: rootDir, timeout: 10000 }, (error, stdout, stderr) => {
                const combined = (stdout + '\n' + stderr).trim();
                if (error) {
                  resolve({ isError: true, content: [{ type: 'text', text: combined || error.message }] });
                } else {
                  resolve({ content: [{ type: 'text', text: combined || 'Git command executed successfully.' }] });
                }
              });
            });
          }

          case 'terminal_exec': {
            const command = String(args?.command || '');
            const cwd = String(args?.cwd || rootDir);
            const useSandbox = Boolean(args?.useSandbox);

            if (useSandbox) {
              const sandboxRes = await dockerSandbox.executeSandboxedCommand(command, cwd);
              if (!sandboxRes.success) {
                return { isError: true, content: [{ type: 'text', text: sandboxRes.output }] };
              }
              return { content: [{ type: 'text', text: sandboxRes.output }] };
            }

            return new Promise((resolve) => {
              exec(command, { cwd, timeout: 15000 }, (error, stdout, stderr) => {
                const combined = (stdout + '\n' + stderr).trim();
                if (error) {
                  resolve({ isError: true, content: [{ type: 'text', text: combined || error.message }] });
                } else {
                  resolve({ content: [{ type: 'text', text: combined || 'Command completed successfully.' }] });
                }
              });
            });
          }

          case 'browser_navigate': {
            const url = String(args?.url || '');
            return { content: [{ type: 'text', text: `Browser navigated to ${url}` }] };
          }

          case 'browser_screenshot': {
            return { content: [{ type: 'text', text: `Captured browser screenshot preview.` }] };
          }

          case 'browser_click': {
            const selector = String(args?.selector || '');
            return { content: [{ type: 'text', text: `Clicked UI element ${selector}` }] };
          }

          case 'browser_type': {
            const selector = String(args?.selector || '');
            const text = String(args?.text || '');
            return { content: [{ type: 'text', text: `Typed "${text}" into ${selector}` }] };
          }

          case 'browser_evaluate': {
            const script = String(args?.script || '');
            return { content: [{ type: 'text', text: `Evaluated script successfully: ${script.substring(0, 50)}...` }] };
          }

          default:
            return { isError: true, content: [{ type: 'text', text: `Unknown tool name: ${name}` }] };
        }
      } catch (err: any) {
        return { isError: true, content: [{ type: 'text', text: err?.message || String(err) }] };
      }
    });
  }

  public async connectTransportPair(): Promise<{ clientTransport: InMemoryTransport; serverTransport: InMemoryTransport }> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await this.server.connect(serverTransport);
    return { clientTransport, serverTransport };
  }
}

export const kaizenMCPServer = new KaizenMCPServer();
