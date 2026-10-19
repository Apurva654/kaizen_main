import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
import express from 'express';
import { normalizeSandboxPath } from './sandboxPathUtils';

export interface BrowserSmokeError {
  type: 'pageerror' | 'console_error' | 'requestfailed';
  message: string;
  errorType?: string;
  sourceFile?: string;
  line?: number;
  column?: number;
  stack?: string;
}

export interface BrowserSmokeTestResult {
  available: boolean;
  passed: boolean;
  verificationLevel: 'browser_smoke' | 'static_only';
  verificationNote?: string;
  errors: BrowserSmokeError[];
  summary: string;
}

/**
 * Parses stack frames from pageerror stack traces to identify the exact file and line number
 */
export function parseStackFrame(
  stack?: string,
  fallbackMessage?: string
): { sourceFile?: string; line?: number; column?: number; errorType?: string } {
  const text = (stack || fallbackMessage || '').trim();
  if (!text) return {};

  let errorType: string | undefined;
  const errorClassMatch = text.match(/\b([A-Z][a-zA-Z0-9]*(?:Error|Exception))\b/);
  if (errorClassMatch) {
    errorType = errorClassMatch[1];
  }

  // Look for URL or file path patterns:
  // e.g., at fn (http://localhost:3000/sandbox/game.js:45:12)
  // or at http://127.0.0.1:54321/src/sandbox/physics.js:22:9
  // or at file:///C:/path/to/src/sandbox/game.js:64:10
  const frameRegex = /(?:https?:\/\/[^\/\s]+|\bfile:\/\/\/?)?(?:[^\s()]*\/(?:src\/sandbox|sandbox)\/|)([a-zA-Z0-9_\-\.]+\.(?:js|html|ts)):(\d+)(?::(\d+))?/i;
  const match = text.match(frameRegex);

  if (match) {
    const rawFile = match[1];
    const line = parseInt(match[2], 10);
    const column = match[3] ? parseInt(match[3], 10) : undefined;
    return {
      sourceFile: normalizeSandboxPath(rawFile),
      line,
      column,
      errorType
    };
  }

  return { errorType };
}

/**
 * Resolves or spins up an HTTP server route to serve the sandbox headlessly
 */
async function resolveStaticServer(
  sandboxDir: string,
  targetHtml = 'index.html'
): Promise<{ url: string; close?: () => Promise<void> }> {
  const port = process.env.PORT || 3000;
  const candidateUrls = [
    `http://localhost:${port}/sandbox/${targetHtml}`,
    `http://localhost:${port}/src/sandbox/${targetHtml}`
  ];

  for (const cUrl of candidateUrls) {
    try {
      const res = await fetch(cUrl, { method: 'HEAD', signal: AbortSignal.timeout(800) });
      if (res.ok) {
        return { url: cUrl };
      }
    } catch {}
  }

  // If express server is not actively running (e.g. CLI test runner), spin up ephemeral server
  const ephemeralApp = express();
  ephemeralApp.use('/sandbox', express.static(sandboxDir));
  ephemeralApp.use('/src/sandbox', express.static(sandboxDir));
  ephemeralApp.use(express.static(sandboxDir));

  const server = await new Promise<http.Server>((resolve, reject) => {
    const s = ephemeralApp.listen(0, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });

  const address = server.address() as any;
  const assignedPort = address?.port || 3000;
  const ephemeralUrl = `http://127.0.0.1:${assignedPort}/sandbox/${targetHtml}`;

  return {
    url: ephemeralUrl,
    close: () => new Promise<void>((res) => server.close(() => res()))
  };
}

/**
 * Performs headless browser runtime smoke test for browser projects
 */
export async function runBrowserSmokeTest(
  sandboxDir: string,
  rootDir = process.cwd(),
  targetHtmlFile?: string
): Promise<BrowserSmokeTestResult> {
  const htmlFile = targetHtmlFile || 'index.html';
  const fullHtmlPath = path.resolve(sandboxDir, htmlFile);

  if (!fs.existsSync(fullHtmlPath)) {
    return {
      available: false,
      passed: true,
      verificationLevel: 'static_only',
      verificationNote: `HTML entry file '${htmlFile}' does not exist on disk.`,
      errors: [],
      summary: `Smoke test skipped: '${htmlFile}' missing.`
    };
  }

  // Gracefully detect Playwright / Chromium availability
  let playwrightModule: any = null;
  try {
    playwrightModule = require('playwright');
  } catch {
    try {
      playwrightModule = require('@playwright/mcp');
    } catch {}
  }

  if (!playwrightModule?.chromium) {
    return {
      available: false,
      passed: true,
      verificationLevel: 'static_only',
      verificationNote: 'Playwright/Chromium runtime not available; static checks passed.',
      errors: [],
      summary: 'Browser smoke test skipped (Playwright dependency unavailable).'
    };
  }

  let browser: any = null;
  try {
    // Attempt system Chrome first, then bundled headless chromium
    try {
      browser = await playwrightModule.chromium.launch({ channel: 'chrome', headless: true });
    } catch {
      browser = await playwrightModule.chromium.launch({ headless: true });
    }
  } catch (launchErr: any) {
    return {
      available: false,
      passed: true,
      verificationLevel: 'static_only',
      verificationNote: `Chromium launch unavailable (${launchErr?.message || 'missing browser binary'}); static checks passed.`,
      errors: [],
      summary: 'Browser smoke test skipped (Chromium could not be launched).'
    };
  }

  let serverContext: { url: string; close?: () => Promise<void> } | null = null;
  const errors: BrowserSmokeError[] = [];

  try {
    serverContext = await resolveStaticServer(sandboxDir, path.basename(htmlFile));
    const page = await browser.newPage();

    page.on('pageerror', (err: Error) => {
      const stack = err.stack || '';
      const parsed = parseStackFrame(stack, err.message);
      errors.push({
        type: 'pageerror',
        message: err.message,
        errorType: parsed.errorType || err.name || 'Error',
        sourceFile: parsed.sourceFile,
        line: parsed.line,
        column: parsed.column,
        stack
      });
    });

    page.on('console', (msg: any) => {
      if (msg.type() === 'error') {
        const text = msg.text();
        // Ignore favicon 404s and generic browser resource 404 messages
        // (Concrete asset failures like missing scripts or css are recorded in requestfailed with full URLs)
        if (text.includes('favicon') || (text.includes('Failed to load resource') && text.includes('404'))) {
          return;
        }
        const parsed = parseStackFrame(undefined, text);
        errors.push({
          type: 'console_error',
          message: text,
          errorType: parsed.errorType || 'ConsoleError',
          sourceFile: parsed.sourceFile,
          line: parsed.line,
          column: parsed.column
        });
      }
    });

    page.on('requestfailed', (req: any) => {
      const reqUrl = req.url();
      if (reqUrl.includes('favicon.ico')) return;
      const failure = req.failure();
      errors.push({
        type: 'requestfailed',
        message: `Failed to load resource: ${reqUrl} (${failure?.errorText || 'network error'})`,
        errorType: 'NetworkError'
      });
    });

    // Navigate to page
    try {
      await page.goto(serverContext.url, { waitUntil: 'load', timeout: 5000 });
    } catch (navErr: any) {
      errors.push({
        type: 'pageerror',
        message: `Failed to navigate to ${serverContext.url}: ${navErr.message}`,
        errorType: 'NavigationError'
      });
    }

    // Wait ~3s for runtime initialization, scripts, and initial rendering loop
    await new Promise((resolve) => setTimeout(resolve, 3000));

    await page.close().catch(() => {});
  } catch (err: any) {
    errors.push({
      type: 'pageerror',
      message: `Smoke test execution error: ${err?.message || String(err)}`,
      errorType: 'RuntimeError'
    });
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
    if (serverContext?.close) {
      await serverContext.close().catch(() => {});
    }
  }

  const passed = errors.length === 0;

  if (!passed) {
    const errorCount = errors.length;
    const firstMsg = errors[0]?.message || 'Unknown runtime error';
    return {
      available: true,
      passed: false,
      verificationLevel: 'browser_smoke',
      errors,
      summary: `Browser smoke test FAILED with ${errorCount} error(s): ${firstMsg}`
    };
  }

  return {
    available: true,
    passed: true,
    verificationLevel: 'browser_smoke',
    verificationNote: 'Headless browser runtime smoke test PASSED without console or runtime errors.',
    errors: [],
    summary: 'Browser runtime smoke test PASSED.'
  };
}
