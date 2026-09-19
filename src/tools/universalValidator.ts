import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';

export interface ProjectStack {
  language: string;
  framework?: string;
  packageManager?: string;
  buildTool?: string;
  testFramework?: string;
  linter?: string;
  formatter?: string;
}

export interface CompilerConfig {
  typeCheck: string;      // tsc, mypy, go vet, etc
  build: string;          // npm run build, cargo build, etc
  test: string;           // npm test, pytest, cargo test, etc
  lint: string;           // eslint, pylint, etc
  format: string;         // prettier, black, etc
  timeout: number;        // Seconds to wait for completion
}

export interface ParsedError {
  line?: number;
  column?: number;
  file?: string;
  message: string;
  severity: 'error' | 'warning';
  code?: string;
  suggestion?: string;
}

export interface ValidationResult {
  stage: string;
  status: 'PASS' | 'FAIL' | 'WARN' | 'ERROR' | 'SKIPPED';
  durationMs: number;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  errors: ParsedError[];
  message?: string;
}

export interface ValidationReport {
  status: 'PASS' | 'WARN' | 'BLOCKED' | 'ERROR';
  canSubmit: boolean;
  reason?: string;
  warningCount: number;
  criticalCount: number;
  stack: ProjectStack;
  results: ValidationResult[];
  formattedReport: string;
}

export interface FileMetadata {
  name: string;
  path: string;
  isDir?: boolean;
}

/**
 * SECTION 1: AUTO-DETECT LANGUAGE & STACK
 */
export async function detectProjectStack(files: FileMetadata[], workspaceDir: string = process.cwd()): Promise<ProjectStack> {
  const stack: ProjectStack = { language: 'unknown' };
  const fileNames = files.map(f => f.name.toLowerCase());

  // 1. JavaScript / TypeScript
  if (fileNames.includes('package.json')) {
    stack.language = 'JavaScript/TypeScript';
    stack.packageManager = 'npm';
    const pkgPath = path.join(workspaceDir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkgContent = fs.readFileSync(pkgPath, 'utf-8');
        const pkg = JSON.parse(pkgContent);
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        
        if (deps.react || deps['next']) stack.framework = 'React / Next.js';
        else if (deps.vue || deps.nuxt) stack.framework = 'Vue / Nuxt';
        else if (deps.svelte) stack.framework = 'Svelte';
        else if (deps.express || deps.fastify || deps.koa) stack.framework = 'Express / Node.js';
        else stack.framework = 'Node.js';

        stack.testFramework = deps.jest ? 'Jest' : (deps.vitest ? 'Vitest' : (deps.mocha ? 'Mocha' : 'ts-node / tsx'));
        stack.linter = deps.eslint ? 'ESLint' : 'unknown';
        stack.formatter = deps.prettier ? 'Prettier' : 'unknown';
      } catch {}
    }
    return stack;
  }

  // 2. Python
  if (fileNames.includes('pyproject.toml') || fileNames.includes('requirements.txt') || fileNames.some(n => n.endsWith('.py'))) {
    stack.language = 'Python';
    stack.packageManager = 'pip';
    const reqPath = path.join(workspaceDir, 'requirements.txt');
    let reqContent = '';
    if (fs.existsSync(reqPath)) {
      try { reqContent = fs.readFileSync(reqPath, 'utf-8').toLowerCase(); } catch {}
    }

    if (reqContent.includes('django')) stack.framework = 'Django';
    else if (reqContent.includes('fastapi')) stack.framework = 'FastAPI';
    else if (reqContent.includes('flask')) stack.framework = 'Flask';
    else stack.framework = 'Python Standard Library';

    stack.testFramework = reqContent.includes('pytest') ? 'pytest' : 'unittest';
    stack.linter = reqContent.includes('pylint') ? 'pylint' : (reqContent.includes('flake8') ? 'flake8' : 'mypy');
    stack.formatter = reqContent.includes('black') ? 'black' : 'autopep8';
    return stack;
  }

  // 3. Go
  if (fileNames.includes('go.mod') || fileNames.some(n => n.endsWith('.go'))) {
    stack.language = 'Go';
    stack.packageManager = 'go get';
    stack.buildTool = 'go build';
    stack.testFramework = 'testing';
    stack.linter = 'golangci-lint';
    stack.formatter = 'gofmt';
    return stack;
  }

  // 4. Rust
  if (fileNames.includes('cargo.toml') || fileNames.some(n => n.endsWith('.rs'))) {
    stack.language = 'Rust';
    stack.packageManager = 'cargo';
    stack.buildTool = 'cargo build';
    stack.testFramework = 'cargo test';
    stack.linter = 'clippy';
    stack.formatter = 'rustfmt';
    return stack;
  }

  // 5. Java
  if (fileNames.includes('pom.xml') || fileNames.includes('build.gradle') || fileNames.some(n => n.endsWith('.java'))) {
    stack.language = 'Java';
    stack.packageManager = fileNames.includes('pom.xml') ? 'Maven' : 'Gradle';
    stack.buildTool = fileNames.includes('pom.xml') ? 'mvn' : 'gradle';
    stack.testFramework = 'JUnit';
    stack.linter = 'Checkstyle';
    return stack;
  }

  // 6. C# / .NET
  if (fileNames.some(n => n.endsWith('.csproj') || n.endsWith('.sln') || n.endsWith('.cs'))) {
    stack.language = 'C#';
    stack.packageManager = 'NuGet';
    stack.buildTool = 'dotnet build';
    stack.testFramework = 'xUnit / NUnit';
    stack.linter = 'Roslyn';
    return stack;
  }

  // 7. C / C++
  if (fileNames.includes('cmakelists.txt') || fileNames.includes('makefile') || fileNames.some(n => n.endsWith('.cpp') || n.endsWith('.cc') || n.endsWith('.c'))) {
    stack.language = 'C/C++';
    stack.buildTool = fileNames.includes('cmakelists.txt') ? 'cmake' : 'g++ / clang++';
    stack.testFramework = 'GoogleTest / Catch2';
    stack.linter = 'cppcheck';
    return stack;
  }

  // 8. PHP
  if (fileNames.includes('composer.json') || fileNames.some(n => n.endsWith('.php'))) {
    stack.language = 'PHP';
    stack.packageManager = 'composer';
    stack.testFramework = 'PHPUnit';
    stack.linter = 'PHP_CodeSniffer';
    return stack;
  }

  // Fallback check by extension
  if (fileNames.some(n => n.endsWith('.ts') || n.endsWith('.tsx') || n.endsWith('.js'))) {
    stack.language = 'JavaScript/TypeScript';
  } else if (fileNames.some(n => n.endsWith('.py'))) {
    stack.language = 'Python';
  } else if (fileNames.some(n => n.endsWith('.go'))) {
    stack.language = 'Go';
  } else if (fileNames.some(n => n.endsWith('.rs'))) {
    stack.language = 'Rust';
  }

  return stack;
}

/**
 * SECTION 2: MAP STACK TO COMPILER & TEST COMMANDS
 */
export async function getCompilerConfig(stack: ProjectStack): Promise<CompilerConfig> {
  const configs: Record<string, CompilerConfig> = {
    'JavaScript/TypeScript': {
      typeCheck: 'npx tsc --noEmit',
      build: 'npm run build || npx tsc',
      test: 'npm test',
      lint: 'npx eslint . --ext .ts,.tsx,.js,.jsx',
      format: 'npx prettier --write .',
      timeout: 30,
    },
    'Python': {
      typeCheck: 'python -m mypy . --strict || python -m py_compile src/sandbox/*.py',
      build: 'python -m py_compile src/sandbox/*.py',
      test: 'python -m unittest discover -s src/sandbox/tests -p "test_*.py" || pytest',
      lint: 'python -m flake8 src/sandbox/ || python -m pylint src/sandbox/',
      format: 'python -m black .',
      timeout: 30,
    },
    'Go': {
      typeCheck: 'go vet ./...',
      build: 'go build ./...',
      test: 'go test ./...',
      lint: 'golangci-lint run ./...',
      format: 'gofmt -w .',
      timeout: 30,
    },
    'Rust': {
      typeCheck: 'cargo check',
      build: 'cargo build',
      test: 'cargo test',
      lint: 'cargo clippy -- -D warnings',
      format: 'cargo fmt',
      timeout: 45,
    },
    'Java': {
      typeCheck: 'javac -d . *.java',
      build: 'mvn clean compile || gradle build',
      test: 'mvn test || gradle test',
      lint: 'mvn checkstyle:check || gradle checkstyleMain',
      format: 'google-java-format -i *.java',
      timeout: 45,
    },
    'C#': {
      typeCheck: 'dotnet build --no-restore',
      build: 'dotnet build',
      test: 'dotnet test',
      lint: 'dotnet build /p:TreatWarningsAsErrors=true',
      format: 'dotnet format',
      timeout: 45,
    },
    'C/C++': {
      typeCheck: 'g++ -fsyntax-only *.cpp',
      build: 'g++ -std=c++17 -Wall *.cpp -o app',
      test: './app',
      lint: 'cppcheck .',
      format: 'clang-format -i *.cpp',
      timeout: 30,
    },
    'PHP': {
      typeCheck: 'php -l *.php',
      build: 'php -l *.php',
      test: 'vendor/bin/phpunit',
      lint: 'vendor/bin/phpcs',
      format: 'vendor/bin/phpcbf',
      timeout: 30,
    }
  };

  return configs[stack.language] || {
    typeCheck: 'npx tsc --noEmit',
    build: 'npm run build',
    test: 'npm test',
    lint: 'npx eslint .',
    format: 'npx prettier --write .',
    timeout: 30,
  };
}

/**
 * SECTION 3: PARSE ERRORS BY LANGUAGE & REGEX PATTERNS
 */
export function parseErrors(output: string, language: string): ParsedError[] {
  const errors: ParsedError[] = [];
  if (!output) return errors;

  // 1. TypeScript / JavaScript
  if (language === 'JavaScript/TypeScript') {
    const tsPattern = /^([^:]+):(\d+):(\d+) - error TS(\d+): (.+)$/gm;
    let match;
    while ((match = tsPattern.exec(output)) !== null) {
      errors.push({
        file: match[1],
        line: parseInt(match[2]),
        column: parseInt(match[3]),
        code: 'TS' + match[4],
        message: match[5],
        severity: 'error'
      });
    }

    const eslintPattern = /^\s*(\d+):(\d+)\s+(error|warning)\s+(.+?)\s+([a-zA-Z0-9\-\/]+)$/gm;
    while ((match = eslintPattern.exec(output)) !== null) {
      errors.push({
        line: parseInt(match[1]),
        column: parseInt(match[2]),
        severity: match[3] === 'error' ? 'error' : 'warning',
        message: match[4],
        code: match[5]
      });
    }
  }

  // 2. Python
  if (language === 'Python') {
    const pyPattern = /File "([^"]+)", line (\d+)(?:, in \w+)?\s*\n\s*(?:.+\n\s*)?(\S+Error): (.+)/g;
    let match;
    while ((match = pyPattern.exec(output)) !== null) {
      errors.push({
        file: match[1],
        line: parseInt(match[2]),
        code: match[3],
        message: match[4],
        severity: 'error'
      });
    }

    const flake8Pattern = /^([^:]+):(\d+):(\d+): ([EWF]\d+)\s+(.+)$/gm;
    while ((match = flake8Pattern.exec(output)) !== null) {
      errors.push({
        file: match[1],
        line: parseInt(match[2]),
        column: parseInt(match[3]),
        code: match[4],
        message: match[5],
        severity: match[4].startsWith('E') ? 'error' : 'warning'
      });
    }
  }

  // 3. Go
  if (language === 'Go') {
    const goPattern = /^([^:\n]+):(\d+):(\d+): (.+)$/gm;
    let match;
    while ((match = goPattern.exec(output)) !== null) {
      errors.push({
        file: match[1],
        line: parseInt(match[2]),
        column: parseInt(match[3]),
        message: match[4],
        severity: 'error'
      });
    }
  }

  // 4. Rust
  if (language === 'Rust') {
    const rustPattern = /error\[(\w+)\]: (.+)\s+-->\s+([^:]+):(\d+):(\d+)/g;
    let match;
    while ((match = rustPattern.exec(output)) !== null) {
      errors.push({
        code: match[1],
        message: match[2],
        file: match[3],
        line: parseInt(match[4]),
        column: parseInt(match[5]),
        severity: 'error'
      });
    }
  }

  // 5. Java
  if (language === 'Java') {
    const javaPattern = /^([^:\n]+):(\d+): error: (.+)$/gm;
    let match;
    while ((match = javaPattern.exec(output)) !== null) {
      errors.push({
        file: match[1],
        line: parseInt(match[2]),
        message: match[3],
        severity: 'error'
      });
    }
  }

  // 6. C#
  if (language === 'C#') {
    const csPattern = /^([^(\n]+)\((\d+),(\d+)\): error (CS\d+): (.+)$/gm;
    let match;
    while ((match = csPattern.exec(output)) !== null) {
      errors.push({
        file: match[1],
        line: parseInt(match[2]),
        column: parseInt(match[3]),
        code: match[4],
        message: match[5],
        severity: 'error'
      });
    }
  }

  // Generic fallback parser if no specific structured errors matched
  if (errors.length === 0 && (output.includes('Error') || output.includes('error') || output.includes('FAIL'))) {
    const genericLines = output.split('\n').filter(l => /error|fail|exception/i.test(l));
    for (const line of genericLines.slice(0, 10)) {
      errors.push({
        message: line.trim(),
        severity: 'error'
      });
    }
  }

  return errors;
}

/**
 * SECTION 4: AUTO-COMMAND EXECUTION TOOL
 */
function executeCommand(cmd: string, cwd: string, timeoutMs: number = 30000): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const startTime = Date.now();
    exec(cmd, { cwd, timeout: timeoutMs }, (error, stdout, stderr) => {
      const exitCode = error ? (error.code || 1) : 0;
      resolve({
        stdout: stdout || '',
        stderr: stderr || '',
        exitCode
      });
    });
  });
}

/**
 * SECTION 5: AUTOMATED VALIDATION PIPELINE
 */
export async function runValidationPipeline(
  stack: ProjectStack,
  config: CompilerConfig,
  workspaceDir: string = process.cwd()
): Promise<ValidationResult[]> {
  const results: ValidationResult[] = [];

  const stages = [
    {
      name: 'Type Checking',
      command: config.typeCheck,
      shouldBlock: true,
    },
    {
      name: 'Compilation/Build',
      command: config.build,
      shouldBlock: true,
    },
    {
      name: 'Linting',
      command: config.lint,
      shouldBlock: false,
    },
    {
      name: 'Unit Tests',
      command: config.test,
      shouldBlock: false,
    }
  ];

  for (const stage of stages) {
    if (!stage.command || stage.command.includes('Unsupported')) {
      results.push({
        stage: stage.name,
        status: 'SKIPPED',
        durationMs: 0,
        errors: [],
        message: 'Stage skipped (no command configured)'
      });
      continue;
    }

    const startTime = Date.now();
    try {
      const { stdout, stderr, exitCode } = await executeCommand(stage.command, workspaceDir, config.timeout * 1000);
      const durationMs = Date.now() - startTime;
      const combinedOutput = `${stdout}\n${stderr}`;
      const parsedErrs = parseErrors(combinedOutput, stack.language);

      if (exitCode === 0) {
        results.push({
          stage: stage.name,
          status: 'PASS',
          durationMs,
          exitCode,
          stdout,
          stderr,
          errors: parsedErrs.filter(e => e.severity === 'warning'),
          message: '✓ Passed cleanly'
        });
      } else {
        const isCritical = stage.shouldBlock;
        results.push({
          stage: stage.name,
          status: isCritical ? 'FAIL' : 'WARN',
          durationMs,
          exitCode,
          stdout,
          stderr,
          errors: parsedErrs,
          message: isCritical ? `❌ ${stage.name} Failed (exit code ${exitCode})` : `⚠️ ${stage.name} Warnings`
        });
      }
    } catch (err: any) {
      results.push({
        stage: stage.name,
        status: 'ERROR',
        durationMs: Date.now() - startTime,
        errors: [{ message: err?.message || String(err), severity: 'error' }],
        message: `Execution error: ${err?.message || err}`
      });
    }
  }

  return results;
}

/**
 * SECTION 6: PRE-SUBMISSION VALIDATION GATE
 */
export async function validateBeforeSubmission(
  filesInWorkspace: FileMetadata[],
  workspaceDir: string = process.cwd()
): Promise<ValidationReport> {
  const stack = await detectProjectStack(filesInWorkspace, workspaceDir);
  const config = await getCompilerConfig(stack);
  const results = await runValidationPipeline(stack, config, workspaceDir);

  const criticalFailures = results.filter(r => r.status === 'FAIL' || r.status === 'ERROR');
  const warnings = results.filter(r => r.status === 'WARN');

  const criticalCount = criticalFailures.reduce((acc, r) => acc + r.errors.length, 0);
  const warningCount = warnings.reduce((acc, r) => acc + r.errors.length, 0);

  const canSubmit = criticalFailures.length === 0;
  const status: ValidationReport['status'] = canSubmit ? (warnings.length > 0 ? 'WARN' : 'PASS') : 'BLOCKED';

  const formattedReport = generateValidationReportText(stack, results, canSubmit, status);

  return {
    status,
    canSubmit,
    reason: canSubmit ? undefined : `${criticalFailures.length} critical stage failure(s) detected`,
    warningCount,
    criticalCount,
    stack,
    results,
    formattedReport
  };
}

/**
 * SECTION 7: DETAILED REPORT FORMATTER
 */
export function generateValidationReportText(
  stack: ProjectStack,
  results: ValidationResult[],
  canSubmit: boolean,
  status: 'PASS' | 'WARN' | 'BLOCKED' | 'ERROR'
): string {
  let report = `╔════════════════════════════════════════════════════════════════╗\n`;
  report += `║       UNIVERSAL CODE VALIDATION REPORT: [${stack.language || 'Multi-Stack'}]        ║\n`;
  report += `╚════════════════════════════════════════════════════════════════╝\n\n`;

  report += `🔍 DETECTED STACK\n`;
  report += `  Language:         ${stack.language}\n`;
  report += `  Framework:        ${stack.framework || 'Standard'}\n`;
  report += `  Package Manager:  ${stack.packageManager || 'System'}\n`;
  report += `  Test Framework:   ${stack.testFramework || 'Automated'}\n`;
  report += `  Linter/Check:     ${stack.linter || 'Native Compiler'}\n\n`;

  report += `⏱️ VALIDATION PIPELINE RESULTS\n\n`;

  for (let i = 0; i < results.length; i++) {
    const res = results[i];
    const icon = res.status === 'PASS' ? '✅' : (res.status === 'WARN' ? '⚠️' : (res.status === 'SKIPPED' ? '⏭️' : '❌'));
    report += `  [${i + 1}/${results.length}] ${res.stage}\n`;
    report += `    Status:   ${icon} ${res.status}\n`;
    report += `    Duration: ${(res.durationMs / 1000).toFixed(2)}s\n`;
    
    if (res.errors && res.errors.length > 0) {
      report += `    Issues (${res.errors.length}):\n`;
      for (const err of res.errors.slice(0, 5)) {
        const loc = err.file ? `${err.file}:${err.line || 1}` : `Line ${err.line || '?'}`;
        report += `      - [${err.severity.toUpperCase()}] ${loc} - ${err.message}\n`;
      }
    }
    report += `\n`;
  }

  report += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
  report += `📊 SUMMARY\n`;
  report += `  Gate Status:      ${canSubmit ? '🟢 READY FOR SUBMISSION' : '🔴 SUBMISSION BLOCKED'}\n`;
  report += `  Critical Failures: ${results.filter(r => r.status === 'FAIL' || r.status === 'ERROR').length}\n`;
  report += `  Warnings:          ${results.filter(r => r.status === 'WARN').length}\n`;
  report += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;

  return report;
}
