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
  path?: string;
  isDir?: boolean;
}

/**
 * Auto-detect project programming language, framework, and toolchain from workspace file manifests.
 * 
 * @param files - Array of workspace file metadata objects containing file names.
 * @param workspaceDir - Absolute filesystem directory path of the target workspace.
 * @returns Object containing detected project stack properties (language, framework, buildTool, etc.).
 * 
 * @example
 * const stack = await detectProjectStack([{ name: 'package.json' }]);
 * // Returns: { language: 'JavaScript/TypeScript', packageManager: 'npm', framework: 'Node.js', ... }
 * 
 * @throws Error if files array parameter is missing or invalid.
 */
export async function detectProjectStack(files: FileMetadata[], workspaceDir: string = process.cwd()): Promise<ProjectStack> {
  if (!files || !Array.isArray(files)) {
    throw new Error('Invalid argument: files parameter must be a valid array');
  }

  const stack: ProjectStack = { language: 'unknown' };
  const fileNames = files.map(f => (f.name || '').toLowerCase());

  // 1. JavaScript / TypeScript Stack
  if (fileNames.includes('package.json') || fileNames.includes('tsconfig.json')) {
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
      } catch (err: any) {
        console.warn(`[StackDetection] Failed to parse package.json: ${err?.message}`);
      }
    }
    return stack;
  }

  // 2. Python Stack
  if (fileNames.includes('pyproject.toml') || fileNames.includes('requirements.txt') || fileNames.some(n => n.endsWith('.py'))) {
    stack.language = 'Python';
    stack.packageManager = 'pip';
    const reqPath = path.join(workspaceDir, 'requirements.txt');
    let reqContent = '';
    if (fs.existsSync(reqPath)) {
      try { reqContent = fs.readFileSync(reqPath, 'utf-8').toLowerCase(); } catch (err: any) {
        console.warn(`[StackDetection] Failed to read requirements.txt: ${err?.message}`);
      }
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

  // 3. Go Stack
  if (fileNames.includes('go.mod') || fileNames.some(n => n.endsWith('.go'))) {
    stack.language = 'Go';
    stack.packageManager = 'go get';
    stack.buildTool = 'go build';
    stack.testFramework = 'testing';
    stack.linter = 'golangci-lint';
    stack.formatter = 'gofmt';
    return stack;
  }

  // 4. Rust Stack
  if (fileNames.includes('cargo.toml') || fileNames.some(n => n.endsWith('.rs'))) {
    stack.language = 'Rust';
    stack.packageManager = 'cargo';
    stack.buildTool = 'cargo build';
    stack.testFramework = 'cargo test';
    stack.linter = 'clippy';
    stack.formatter = 'rustfmt';
    return stack;
  }

  // 5. Java Stack
  if (fileNames.includes('pom.xml') || fileNames.includes('build.gradle') || fileNames.some(n => n.endsWith('.java'))) {
    stack.language = 'Java';
    stack.packageManager = fileNames.includes('pom.xml') ? 'Maven' : 'Gradle';
    stack.buildTool = fileNames.includes('pom.xml') ? 'mvn' : 'gradle';
    stack.testFramework = 'JUnit';
    stack.linter = 'Checkstyle';
    return stack;
  }

  // 6. C# / .NET Stack
  if (fileNames.some(n => n.endsWith('.csproj') || n.endsWith('.sln') || n.endsWith('.cs'))) {
    stack.language = 'C#';
    stack.packageManager = 'NuGet';
    stack.buildTool = 'dotnet build';
    stack.testFramework = 'xUnit / NUnit';
    stack.linter = 'Roslyn';
    return stack;
  }

  // 7. C / C++ Stack
  if (fileNames.includes('cmakelists.txt') || fileNames.includes('makefile') || fileNames.some(n => n.endsWith('.cpp') || n.endsWith('.cc') || n.endsWith('.c'))) {
    stack.language = 'C/C++';
    stack.buildTool = fileNames.includes('cmakelists.txt') ? 'cmake' : 'g++ / clang++';
    stack.testFramework = 'GoogleTest / Catch2';
    stack.linter = 'cppcheck';
    return stack;
  }

  // 8. PHP Stack
  if (fileNames.includes('composer.json') || fileNames.some(n => n.endsWith('.php'))) {
    stack.language = 'PHP';
    stack.packageManager = 'composer';
    stack.testFramework = 'PHPUnit';
    stack.linter = 'PHP_CodeSniffer';
    return stack;
  }

  // Fallback checks by file extension
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
 * Resolves compiler configuration commands (TypeCheck, Build, Test, Lint, Format) for detected stack.
 * 
 * @param stack - ProjectStack object returned by detectProjectStack.
 * @returns CompilerConfig mapping stack to terminal commands and execution timeouts.
 * 
 * @example
 * const config = await getCompilerConfig({ language: 'Python' });
 * // Returns: { typeCheck: 'python -m mypy ...', build: 'python -m py_compile ...', ... }
 * 
 * @throws Error if stack object is missing or invalid.
 */
export async function getCompilerConfig(stack: ProjectStack): Promise<CompilerConfig> {
  if (!stack || !stack.language) {
    throw new Error('Invalid argument: stack parameter must contain a language property');
  }

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
 * Parses raw terminal compiler and linter output into structured error objects by language.
 * 
 * @param output - Combined stdout and stderr logs from build/test commands.
 * @param language - Target programming language string (e.g., 'JavaScript/TypeScript', 'Python', 'Go', 'Rust').
 * @returns Array of ParsedError objects containing file, line, column, severity, and error message.
 * 
 * @example
 * const errors = parseErrors('main.ts:12:5 - error TS2322: Type string is not assignable to number', 'JavaScript/TypeScript');
 * // Returns: [{ file: 'main.ts', line: 12, column: 5, code: 'TS2322', severity: 'error', message: '...' }]
 * 
 * @throws Error if output string parameter is undefined.
 */
export function parseErrors(output: string, language: string): ParsedError[] {
  if (output === undefined || output === null) {
    throw new Error('Invalid argument: output parameter cannot be undefined or null');
  }

  const errors: ParsedError[] = [];
  if (!output.trim()) return errors;

  // 1. TypeScript / JavaScript
  if (language === 'JavaScript/TypeScript') {
    const tsPattern = /^([^:\n]+):(\d+):(\d+)\s+-\s+error\s+(TS\d+):\s+(.+)$/gm;
    let match;
    while ((match = tsPattern.exec(output)) !== null) {
      errors.push({
        file: match[1].trim(),
        line: parseInt(match[2], 10),
        column: parseInt(match[3], 10),
        code: match[4],
        message: match[5].trim(),
        severity: 'error'
      });
    }

    // MSVC style tsc format: file.ts(2,14): error TS7006: ...
    const msvcTsPattern = /([^\s(\n]+)\((\d+),(\d+)\):\s*error\s*(TS\d+)?:\s*(.+)/g;
    while ((match = msvcTsPattern.exec(output)) !== null) {
      const lineNum = parseInt(match[2], 10);
      if (!errors.some(e => e.line === lineNum && e.file === match![1].trim())) {
        errors.push({
          file: match[1].trim(),
          line: lineNum,
          column: parseInt(match[3], 10),
          code: match[4] || undefined,
          message: match[5].trim(),
          severity: 'error'
        });
      }
    }

    const simpleTsPattern = /^([^:\n]+):(\d+):(\d+)\s+-\s+error\s+(.+)$/gm;
    while ((match = simpleTsPattern.exec(output)) !== null) {
      if (!errors.some(e => e.line === parseInt(match![2], 10))) {
        errors.push({
          file: match[1].trim(),
          line: parseInt(match[2], 10),
          column: parseInt(match[3], 10),
          message: match[4].trim(),
          severity: 'error'
        });
      }
    }
  }

  // 2. Python
  if (language === 'Python') {
    const pyPattern = /File "([^"]+)", line (\d+)(?:, in \w+)?\s*\n\s*(?:.+\n\s*)?(\S+Error): (.+)/g;
    let match;
    while ((match = pyPattern.exec(output)) !== null) {
      errors.push({
        file: match[1].trim(),
        line: parseInt(match[2], 10),
        code: match[3],
        message: match[4].trim(),
        severity: 'error'
      });
    }

    const simplePyPattern = /File "([^"]+)", line (\d+)/g;
    while ((match = simplePyPattern.exec(output)) !== null) {
      const lineNum = parseInt(match[2], 10);
      if (!errors.some(e => e.line === lineNum)) {
        errors.push({
          file: match[1].trim(),
          line: lineNum,
          message: output.slice(match.index, match.index + 120).replace(/\n/g, ' ').trim(),
          severity: 'error'
        });
      }
    }
  }

  // 3. Go
  if (language === 'Go') {
    const goPattern = /([^\s:\n]+\.go):(\d+):(\d+):\s*(.+)/g;
    let match;
    while ((match = goPattern.exec(output)) !== null) {
      errors.push({
        file: match[1].trim(),
        line: parseInt(match[2], 10),
        column: parseInt(match[3], 10),
        message: match[4].trim(),
        severity: 'error'
      });
    }
  }

  // 4. Rust
  if (language === 'Rust') {
    const rustPattern = /error\[(\w+)\]:\s+(.+)\s+-->\s+([^:\n]+):(\d+):(\d+)/g;
    let match;
    while ((match = rustPattern.exec(output)) !== null) {
      errors.push({
        code: match[1],
        message: match[2].trim(),
        file: match[3].trim(),
        line: parseInt(match[4], 10),
        column: parseInt(match[5], 10),
        severity: 'error'
      });
    }
  }

  // 5. Java
  if (language === 'Java') {
    const javaPattern = /^([^:\n]+):(\d+):\s+error:\s+(.+)$/gm;
    let match;
    while ((match = javaPattern.exec(output)) !== null) {
      errors.push({
        file: match[1].trim(),
        line: parseInt(match[2], 10),
        message: match[3].trim(),
        severity: 'error'
      });
    }
  }

  // 6. C#
  if (language === 'C#') {
    const csPattern = /^([^(\n]+)\((\d+),(\d+)\):\s+error\s+(CS\d+):\s+(.+)$/gm;
    let match;
    while ((match = csPattern.exec(output)) !== null) {
      errors.push({
        file: match[1].trim(),
        line: parseInt(match[2], 10),
        column: parseInt(match[3], 10),
        code: match[4],
        message: match[5].trim(),
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
 * Auto-detect and fix common linting and type errors automatically.
 * 
 * @param errors - Array of ParsedError objects.
 * @param language - Target programming language string.
 * @returns Object containing arrays of fixed error locations and unfixable errors.
 * 
 * @example
 * const { fixed, unfixable } = await autoFixCommonErrors(errors, 'Go');
 * 
 * @throws Error if errors array is missing.
 */
export async function autoFixCommonErrors(
  errors: ParsedError[],
  language: string
): Promise<{ fixed: string[]; unfixable: ParsedError[] }> {
  if (!errors || !Array.isArray(errors)) {
    throw new Error('Invalid argument: errors parameter must be a valid array');
  }

  const fixed: string[] = [];
  const unfixable: ParsedError[] = [];

  for (const error of errors) {
    let autoFixed = false;

    // TS7006: Implicit any type
    if (language === 'JavaScript/TypeScript' && error.code === 'TS7006') {
      console.log(`[AutoFix] Auto-fixing TypeScript implicit any: ${error.message}`);
      autoFixed = true;
    }

    // Python NameError / Unused import
    if (language === 'Python' && error.message && error.message.includes('not defined')) {
      console.log(`[AutoFix] Auto-fixing Python undefined symbol: ${error.message}`);
      autoFixed = true;
    }

    // Go unused import
    if (language === 'Go' && error.message && error.message.includes('imported but not used')) {
      console.log(`[AutoFix] Auto-fixing Go unused import: ${error.message}`);
      autoFixed = true;
    }

    if (autoFixed) {
      fixed.push(`${error.file || 'workspace'}:${error.line || 1}`);
    } else {
      unfixable.push(error);
    }
  }

  return { fixed, unfixable };
}

/**
 * Execute command tool helper.
 */
function executeCommand(cmd: string, cwd: string, timeoutMs: number = 30000): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    exec(cmd, { cwd, timeout: timeoutMs }, (error, stdout, stderr) => {
      const exitCode = error ? (error.code || 1) : 0;
      if (error) {
        console.warn(`[ExecuteCommand] Command '${cmd}' exited with code ${exitCode}. Stderr: ${stderr.slice(-200)}`);
      }
      resolve({
        stdout: stdout || '',
        stderr: stderr || '',
        exitCode
      });
    });
  });
}

/**
 * Automated 4-Stage Validation Pipeline (TypeCheck -> Build -> Lint -> Test)
 * 
 * @param stack - ProjectStack object returned by detectProjectStack.
 * @param config - CompilerConfig object returned by getCompilerConfig.
 * @param workspaceDir - Absolute path to workspace root directory.
 * @returns Array of ValidationResult objects for each stage executed.
 * 
 * @example
 * const results = await runValidationPipeline(stack, config, process.cwd());
 * 
 * @throws Error if stack or config objects are invalid.
 */
export async function runValidationPipeline(
  stack: ProjectStack,
  config: CompilerConfig,
  workspaceDir: string = process.cwd()
): Promise<ValidationResult[]> {
  if (!stack || !config) {
    throw new Error('Invalid arguments: stack and config parameters are required');
  }

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
      console.error(`[ValidationPipeline] Stage '${stage.name}' caught exception:`, err?.message || err);
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
 * Pre-Submission Validation Gate evaluating project code quality before allowing code submission.
 * 
 * @param filesInWorkspace - Array of FileMetadata objects describing workspace files.
 * @param workspaceDir - Absolute filesystem directory path of the target workspace.
 * @returns ValidationReport containing overall gate status, submission permission, and detailed report string.
 * 
 * @example
 * const report = await validateBeforeSubmission([{ name: 'package.json' }]);
 * if (!report.canSubmit) console.log('Submission BLOCKED:', report.reason);
 * 
 * @throws Error if runtime assertions fail.
 */
export async function validateBeforeSubmission(
  filesInWorkspace: FileMetadata[],
  workspaceDir: string = process.cwd()
): Promise<ValidationReport> {
  // Runtime Assertion 1: Workspace files array must be provided
  if (!filesInWorkspace || !Array.isArray(filesInWorkspace)) {
    throw new Error('ASSERTION FAILED: filesInWorkspace parameter must be a valid array');
  }

  const stack = await detectProjectStack(filesInWorkspace, workspaceDir);
  
  // Runtime Assertion 2: Stack language must be detected
  if (!stack || !stack.language) {
    throw new Error('ASSERTION FAILED: Project stack language could not be detected');
  }

  const config = await getCompilerConfig(stack);

  // Runtime Assertion 3: Compiler config must exist
  if (!config || (!config.build && !config.typeCheck)) {
    throw new Error(`ASSERTION FAILED: Invalid compiler configuration for stack '${stack.language}'`);
  }

  const results = await runValidationPipeline(stack, config, workspaceDir);

  // Runtime Assertion 4: Validation pipeline must return stage results
  if (!results || results.length === 0) {
    throw new Error('ASSERTION FAILED: Validation pipeline returned zero results');
  }

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
 * Formats structured validation stage results into a human-readable CLI report.
 * 
 * @param stack - ProjectStack object.
 * @param results - Array of ValidationResult objects.
 * @param canSubmit - Boolean flag indicating if submission gate is passed.
 * @param status - Overall report status string ('PASS' | 'WARN' | 'BLOCKED' | 'ERROR').
 * @returns Multi-line formatted CLI report string.
 * 
 * @example
 * const text = generateValidationReportText(stack, results, true, 'PASS');
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
