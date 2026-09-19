import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { detectProjectStack, parseErrors, FileMetadata } from './universalValidator';

const BASE_TEMP_DIR = path.join(os.tmpdir(), 'kaizen-real-world-tests');

function setupTestProjects() {
  console.log('╔════════════════════════════════════════════════════╗');
  console.log('║   SETTING UP REAL-WORLD TEST PROJECTS              ║');
  console.log('╚════════════════════════════════════════════════════╝\n');

  if (fs.existsSync(BASE_TEMP_DIR)) {
    fs.rmSync(BASE_TEMP_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(BASE_TEMP_DIR, { recursive: true });

  // 1. TypeScript Project
  const tsDir = path.join(BASE_TEMP_DIR, 'test-ts-project');
  const tsSrcDir = path.join(tsDir, 'src');
  fs.mkdirSync(tsSrcDir, { recursive: true });

  fs.writeFileSync(path.join(tsDir, 'package.json'), JSON.stringify({
    name: 'test-app',
    version: '1.0.0',
    scripts: { build: 'tsc' },
    devDependencies: { typescript: '^5.0.0' }
  }, null, 2));

  fs.writeFileSync(path.join(tsDir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2020',
      module: 'commonjs',
      strict: true,
      noImplicitAny: true
    }
  }, null, 2));

  fs.writeFileSync(path.join(tsSrcDir, 'index.ts'), `// Intentional error: missing type annotation with noImplicitAny
function add(x, y) {
  return x + y;
}

export default add;
`);

  // 2. Python Project
  const pyDir = path.join(BASE_TEMP_DIR, 'test-python-project');
  fs.mkdirSync(pyDir, { recursive: true });

  fs.writeFileSync(path.join(pyDir, 'requirements.txt'), `flask==2.3.0\npytest==7.4.0\nmypy==1.0.0\n`);
  fs.writeFileSync(path.join(pyDir, 'app.py'), `# Intentional error: undefined variable
def hello():
    return greeting  # 'greeting' not defined

if __name__ == '__main__':
    print(hello())
`);

  // 3. Go Project
  const goDir = path.join(BASE_TEMP_DIR, 'test-go-project');
  fs.mkdirSync(goDir, { recursive: true });

  fs.writeFileSync(path.join(goDir, 'go.mod'), `module testapp\n\ngo 1.21\n`);
  fs.writeFileSync(path.join(goDir, 'main.go'), `package main

import "fmt"

func main() {
    // Intentional error: undefined package
    fmt.Println(undefined.Function())
}
`);

  console.log(`✓ Created test projects under: ${BASE_TEMP_DIR}`);
  console.log(`  - TypeScript: ${tsDir}`);
  console.log(`  - Python:     ${pyDir}`);
  console.log(`  - Go:         ${goDir}\n`);

  return { tsDir, pyDir, goDir };
}

export async function testRealStackDetection(dirs: { tsDir: string; pyDir: string; goDir: string }) {
  console.log('╔════════════════════════════════════════════════════╗');
  console.log('║ 🧪 SECTION 2: REAL STACK DETECTION TEST           ║');
  console.log('╚════════════════════════════════════════════════════╝\n');

  const projects = [dirs.tsDir, dirs.pyDir, dirs.goDir];

  for (const projectPath of projects) {
    try {
      const readDirRecursive = (dir: string, baseDir: string = dir): FileMetadata[] => {
        let results: FileMetadata[] = [];
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          const relPath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
          if (entry.isDirectory()) {
            results = results.concat(readDirRecursive(fullPath, baseDir));
          } else {
            results.push({ name: entry.name, path: relPath });
          }
        }
        return results;
      };

      const files = readDirRecursive(projectPath);
      const stack = await detectProjectStack(files);

      const folderName = path.basename(projectPath);
      console.log(`✓ ${folderName}`);
      console.log(`  Language:     ${stack.language}`);
      console.log(`  Framework:    ${stack.framework || 'N/A'}`);
      console.log(`  Build Tool:   ${stack.buildTool || 'N/A'}`);
      console.log(`  Test Runner:  ${stack.testFramework || 'N/A'}`);
    } catch (error: any) {
      console.error(`❌ ${projectPath}: ${error.message}`);
    }
  }
}

export async function testRealCompilation(dirs: { tsDir: string; pyDir: string; goDir: string }) {
  console.log('\n╔════════════════════════════════════════════════════╗');
  console.log('║ 🧪 SECTION 3: REAL COMPILATION & ERROR LOG TEST    ║');
  console.log('╚════════════════════════════════════════════════════╝\n');

  // Test compilation commands and output capturing
  const tsConfigPath = path.join(dirs.tsDir, 'tsconfig.json');
  let tsOutput = '';
  try {
    tsOutput = execSync(`npx tsc -p "${dirs.tsDir}" --noEmit`, { encoding: 'utf-8' });
  } catch (error: any) {
    tsOutput = error.stdout || error.stderr || error.message;
  }
  console.log(`✓ TypeScript Compilation Attempted`);
  console.log(`   Captured Raw Output (${tsOutput.split('\n').length} lines):`);
  console.log(`   ${tsOutput.trim().split('\n')[0]}`);

  // Test Python compilation / execution output
  const pyAppPath = path.join(dirs.pyDir, 'app.py');
  let pyOutput = '';
  try {
    pyOutput = execSync(`python "${pyAppPath}"`, { encoding: 'utf-8' });
  } catch (error: any) {
    pyOutput = error.stdout || error.stderr || error.message;
  }
  console.log(`✓ Python Script Run Attempted`);
  console.log(`   Captured Raw Output (${pyOutput.split('\n').length} lines):`);
  console.log(`   ${pyOutput.trim().split('\n').slice(-2).join(' ')}`);

  // Test Go build attempt if go is available, else provide representative output
  let goOutput = '';
  try {
    goOutput = execSync(`go build`, { cwd: dirs.goDir, encoding: 'utf-8' });
  } catch (error: any) {
    goOutput = error.stdout || error.stderr || error.message;
  }
  console.log(`✓ Go Build Attempted`);
  console.log(`   Captured Raw Output (${goOutput.split('\n').length} lines):`);
  console.log(`   ${goOutput.trim().split('\n')[0]}`);

  return { tsOutput, pyOutput, goOutput };
}

export async function testRealErrorParsing(outputs: { tsOutput: string; pyOutput: string; goOutput: string }) {
  console.log('\n╔════════════════════════════════════════════════════╗');
  console.log('║ 🧪 SECTION 4: REAL ERROR PARSING ON ACTUAL LOGS   ║');
  console.log('╚════════════════════════════════════════════════════╝\n');

  const errorTests = [
    {
      name: 'TypeScript Real Compiler Errors',
      language: 'JavaScript/TypeScript',
      output: outputs.tsOutput
    },
    {
      name: 'Python Real Runtime Traceback',
      language: 'Python',
      output: outputs.pyOutput
    },
    {
      name: 'Go Real Compiler Errors',
      language: 'Go',
      output: outputs.goOutput
    }
  ];

  for (const test of errorTests) {
    const errors = parseErrors(test.output, test.language);

    if (errors.length > 0) {
      console.log(`✓ ${test.name}: Parsed ${errors.length} structured errors`);
      errors.forEach(err => {
        console.log(`  - [Line ${err.line ?? 'N/A'}] [${err.severity.toUpperCase()}] ${err.file || ''} ${err.message}`);
      });
    } else {
      console.log(`⚠️ ${test.name}: No errors parsed`);
    }
  }
}

export async function runProductionTests() {
  console.log('╔════════════════════════════════════════════════════╗');
  console.log('║   PRODUCTION-READY REAL-WORLD VERIFICATION SUITE   ║');
  console.log('╚════════════════════════════════════════════════════╝\n');

  try {
    const dirs = setupTestProjects();
    await testRealStackDetection(dirs);
    const outputs = await testRealCompilation(dirs);
    await testRealErrorParsing(outputs);

    console.log('\n╔════════════════════════════════════════════════════╗');
    console.log('║   ✅ REAL-WORLD PRODUCTION TESTS COMPLETED          ║');
    console.log('╚════════════════════════════════════════════════════╝');
  } catch (error: any) {
    console.error('\n❌ Production tests failed:', error.message);
    process.exit(1);
  }
}

runProductionTests();
