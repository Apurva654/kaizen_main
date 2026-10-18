import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';

export type ConnectionState = 'connected' | 'disconnected' | 'connecting';

export interface HealthStatus {
  status: string;
  version: string;
  uptime: number;
  timestamp: string;
  port: number;
  modelProvider: string;
  defaultModels?: string[];
  permissionMode: string;
  isDryRunMode: boolean;
  isDockerActive: boolean;
}

export interface PipelineRunParams {
  userInput: string;
  imagePayload?: string;
  sessionId?: string;
  workspaceRoot?: string;
}

export interface PipelineRunResponse {
  status: string;
  message: string;
  runId?: string;
}

export interface HitlResponseParams {
  sessionId: string;
  hitlRequestId?: string;
  response: {
    action: 'approve' | 'reject' | 'feedback';
    message?: string;
  };
}

export interface BackendStreamEvent {
  event: string;
  data: any;
}

export type StreamEventHandler = (event: BackendStreamEvent) => void;
export type ConnectionStateChangeHandler = (state: ConnectionState, health?: HealthStatus | null) => void;

export class KaizenBackendClient {
  private baseUrl: string;
  private connectionState: ConnectionState = 'disconnected';
  private lastHealthStatus: HealthStatus | null = null;
  private sseRequest: http.ClientRequest | null = null;
  private isStreamingActive: boolean = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stateChangeListeners: Set<ConnectionStateChangeHandler> = new Set();
  private streamListeners: Set<StreamEventHandler> = new Set();
  private pollTimer: NodeJS.Timeout | null = null;

  constructor(baseUrl: string = 'http://localhost:3000') {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.startHealthPolling();
  }

  private startHealthPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => {
      this.checkHealth(2500).catch(() => {});
    }, 3000);
  }

  public getBaseUrl(): string {
    return this.baseUrl;
  }

  public setBaseUrl(newUrl: string): void {
    const normalized = newUrl.replace(/\/+$/, '');
    if (this.baseUrl !== normalized) {
      this.baseUrl = normalized;
      this.disconnectStream();
      this.checkHealth();
    }
  }

  public getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  public getLastHealthStatus(): HealthStatus | null {
    return this.lastHealthStatus;
  }

  public onConnectionStateChange(listener: ConnectionStateChangeHandler): () => void {
    this.stateChangeListeners.add(listener);
    // Immediately invoke with current state
    listener(this.connectionState, this.lastHealthStatus);
    return () => this.stateChangeListeners.delete(listener);
  }

  public onStreamEvent(listener: StreamEventHandler): () => void {
    this.streamListeners.add(listener);
    return () => this.streamListeners.delete(listener);
  }

  private setConnectionState(newState: ConnectionState, health: HealthStatus | null = null): void {
    const changed = this.connectionState !== newState || this.lastHealthStatus !== health;
    this.connectionState = newState;
    this.lastHealthStatus = health;
    if (changed) {
      for (const listener of this.stateChangeListeners) {
        try {
          listener(this.connectionState, this.lastHealthStatus);
        } catch (err) {
          console.error('[KaizenBackendClient] Error in state change listener:', err);
        }
      }
    }
  }

  /**
   * Performs an HTTP request with timeout, returning parsed JSON
   */
  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: any,
    timeoutMs: number = 6000
  ): Promise<T> {
    const fullUrl = new URL(path, this.baseUrl);
    const isHttps = fullUrl.protocol === 'https:';
    const requester = isHttps ? https.request : http.request;

    const payload = body ? JSON.stringify(body) : undefined;
    const headers: Record<string, string> = {
      'Accept': 'application/json'
    };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload).toString();
    }

    return new Promise<T>((resolve, reject) => {
      const req = requester(
        fullUrl,
        {
          method,
          headers,
          timeout: timeoutMs
        },
        (res) => {
          let responseData = '';
          res.setEncoding('utf8');

          res.on('data', (chunk) => {
            responseData += chunk;
          });

          res.on('end', () => {
            const statusCode = res.statusCode || 0;
            if (statusCode >= 200 && statusCode < 300) {
              try {
                const parsed = JSON.parse(responseData);
                resolve(parsed as T);
              } catch (parseErr) {
                reject(new Error(`Failed to parse backend response JSON: ${responseData.slice(0, 100)}`));
              }
            } else {
              let errorMsg = `Backend request failed with status ${statusCode}`;
              try {
                const errJson = JSON.parse(responseData);
                if (errJson.error || errJson.message) {
                  errorMsg = errJson.error || errJson.message;
                }
              } catch {
                if (responseData.trim()) {
                  errorMsg += `: ${responseData.slice(0, 150)}`;
                }
              }
              reject(new Error(errorMsg));
            }
          });
        }
      );

      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`Request to ${fullUrl.pathname} timed out after ${timeoutMs}ms`));
      });

      req.on('error', (err: any) => {
        if (err.code === 'ECONNREFUSED') {
          reject(new Error(`Backend server unreachable at ${this.baseUrl} (Connection Refused). Ensure "npm run server" is running.`));
        } else {
          reject(err);
        }
      });

      if (payload) {
        req.write(payload);
      }
      req.end();
    });
  }

  /**
   * Checks backend health on /api/health
   */
  public async checkHealth(timeoutMs: number = 3000): Promise<HealthStatus> {
    try {
      const health = await this.request<HealthStatus>('GET', '/api/health', undefined, timeoutMs);
      this.setConnectionState('connected', health);
      return health;
    } catch (err: any) {
      // Windows Node.js dual-stack fallback: if localhost failed, try 127.0.0.1
      if (this.baseUrl.includes('localhost')) {
        try {
          const fallbackUrl = this.baseUrl.replace('localhost', '127.0.0.1');
          const oldUrl = this.baseUrl;
          this.baseUrl = fallbackUrl;
          const health = await this.request<HealthStatus>('GET', '/api/health', undefined, timeoutMs);
          this.setConnectionState('connected', health);
          return health;
        } catch {
          this.baseUrl = this.baseUrl.replace('127.0.0.1', 'localhost');
        }
      }
      this.setConnectionState('disconnected', null);
      throw err;
    }
  }

  /**
   * Submits prompt to /api/pipeline/run
   */
  public async runPipeline(params: PipelineRunParams): Promise<PipelineRunResponse> {
    return this.request<PipelineRunResponse>('POST', '/api/pipeline/run', params, 10000);
  }

  /**
   * Submits human-in-the-loop approval to /api/hitl/respond
   */
  public async respondHitl(
    sessionId: string,
    action: 'approve' | 'reject' | 'feedback',
    message?: string
  ): Promise<{ status: string; message: string }> {
    return this.request('POST', '/api/hitl/respond', {
      sessionId,
      response: { action, message }
    }, 5000);
  }

  /**
   * Fetches permission status from /api/permission/status
   */
  public async getPermissionStatus(): Promise<any> {
    return this.request('GET', '/api/permission/status', undefined, 4000);
  }

  /**
   * Updates permission mode on /api/permission/mode
   */
  public async setPermissionMode(mode: 'deny_first' | 'auto_mode'): Promise<any> {
    return this.request('POST', '/api/permission/mode', { mode }, 4000);
  }

  /**
   * Clears memory via /api/memory/clear
   */
  public async clearMemory(): Promise<{ success: boolean; message: string }> {
    return this.request('POST', '/api/memory/clear', {}, 5000);
  }

  private activeStreamSessionId?: string;

  /**
   * Connects to Server-Sent Events stream (/api/stream) and auto-reconnects
   */
  public connectStream(sessionId?: string): void {
    if (sessionId) {
      this.activeStreamSessionId = sessionId;
    }
    if (this.isStreamingActive) return;
    this.isStreamingActive = true;

    this.startSseConnection();
  }

  private startSseConnection(): void {
    if (!this.isStreamingActive) return;

    const streamPath = this.activeStreamSessionId
      ? `/api/stream?sessionId=${encodeURIComponent(this.activeStreamSessionId)}`
      : '/api/stream';
    const fullUrl = new URL(streamPath, this.baseUrl);
    const isHttps = fullUrl.protocol === 'https:';
    const requester = isHttps ? https.request : http.request;

    this.sseRequest = requester(
      fullUrl,
      {
        method: 'GET',
        headers: {
          'Accept': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        }
      },
      (res) => {
        if (res.statusCode !== 200) {
          this.handleStreamDisconnect();
          return;
        }

        this.setConnectionState('connected', this.lastHealthStatus);

        let buffer = '';
        res.setEncoding('utf8');

        res.on('data', (chunk: string) => {
          buffer += chunk;
          const messages = buffer.split('\n\n');
          buffer = messages.pop() || ''; // Keep remainder

          for (const msg of messages) {
            this.parseAndDispatchSseMessage(msg);
          }
        });

        res.on('end', () => {
          this.handleStreamDisconnect();
        });

        res.on('error', () => {
          this.handleStreamDisconnect();
        });
      }
    );

    this.sseRequest.on('error', () => {
      this.handleStreamDisconnect();
    });

    this.sseRequest.end();
  }

  private parseAndDispatchSseMessage(raw: string): void {
    const lines = raw.split('\n');
    let eventName = 'message';
    let dataStr = '';

    for (const line of lines) {
      if (line.startsWith(':')) {
        // SSE Comment / heartbeat
        continue;
      }
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataStr = line.slice(5).trim();
      }
    }

    if (!dataStr) return;

    try {
      const data = JSON.parse(dataStr);
      const sseEvent: BackendStreamEvent = { event: eventName, data };
      for (const listener of this.streamListeners) {
        try {
          listener(sseEvent);
        } catch (listenerErr) {
          console.error('[KaizenBackendClient] Error in SSE listener:', listenerErr);
        }
      }
    } catch {
      // Non-JSON SSE data
      const sseEvent: BackendStreamEvent = { event: eventName, data: dataStr };
      for (const listener of this.streamListeners) {
        try {
          listener(sseEvent);
        } catch { }
      }
    }
  }

  private handleStreamDisconnect(): void {
    if (this.sseRequest) {
      try { this.sseRequest.destroy(); } catch { }
      this.sseRequest = null;
    }

    if (this.isStreamingActive) {
      // Schedule reconnect attempt in 3s
      if (!this.reconnectTimer) {
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          // Check health first
          this.checkHealth()
            .then(() => {
              if (this.isStreamingActive) {
                this.startSseConnection();
              }
            })
            .catch(() => {
              // Retry again later
              if (this.isStreamingActive) {
                this.handleStreamDisconnect();
              }
            });
        }, 3000);
      }
    }
  }

  public disconnectStream(): void {
    this.isStreamingActive = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.sseRequest) {
      try { this.sseRequest.destroy(); } catch { }
      this.sseRequest = null;
    }
  }

  public dispose(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.disconnectStream();
    this.stateChangeListeners.clear();
    this.streamListeners.clear();
  }
}
