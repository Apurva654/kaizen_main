import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

export function verifyImplementation() {
  console.log('╔════════════════════════════════════════════════════╗');
  console.log('║     BULLETPROOF IMPLEMENTATION VERIFICATION        ║');
  console.log('╚════════════════════════════════════════════════════╝');
  
  const filesToCheck = [
    'src/tools/universalValidator.ts',
    'src/tools/testRunner.ts',
    'src/tools/comprehensiveTestRunner.ts',
  ];

  filesToCheck.forEach(file => {
    const fullPath = resolve(file);
    if (!existsSync(fullPath)) {
      console.log(`❌ FILE NOT FOUND: ${file}`);
      throw new Error(`Critical file missing: ${file}`);
    }
    
    const content = readFileSync(fullPath, 'utf-8');
    const lines = content.split('\n').length;
    console.log(`✓ ${file} (${lines} lines)`);
  });

  console.log('\n✓ All files exist and are readable');
}

export async function verifyExports() {
  console.log('\n╔════════════════════════════════════════════════════╗');
  console.log('║     VERIFYING ALL FUNCTION EXPORTS                 ║');
  console.log('╚════════════════════════════════════════════════════╝');

  try {
    const validator = require('./universalValidator');
    
    const requiredFunctions = [
      'detectProjectStack',
      'getCompilerConfig',
      'parseErrors',
      'runValidationPipeline',
      'validateBeforeSubmission',
      'generateValidationReportText',
      'autoFixCommonErrors',
    ];

    console.log('\nChecking exports:');
    let missingCount = 0;
    
    requiredFunctions.forEach(func => {
      if (typeof validator[func] === 'function') {
        console.log(`✓ ${func} (function)`);
      } else if (typeof validator[func] === 'undefined') {
        console.log(`❌ ${func} (MISSING)`);
        missingCount++;
      } else {
        console.log(`⚠️ ${func} (type: ${typeof validator[func]})`);
      }
    });

    if (missingCount > 0) {
      throw new Error(`${missingCount} critical functions missing from universalValidator`);
    }

    console.log('\n✓ All required functions exported correctly');
  } catch (error: any) {
    console.error(`❌ ERROR: ${error.message}`);
    throw error;
  }
}

export async function testStackDetection() {
  console.log('\n╔════════════════════════════════════════════════════╗');
  console.log('║     TESTING STACK DETECTION                        ║');
  console.log('╚════════════════════════════════════════════════════╝');

  const { detectProjectStack } = require('./universalValidator');

  const testCases = [
    {
      name: 'TypeScript Project',
      files: [
        { name: 'package.json' },
        { name: 'tsconfig.json' },
        { name: 'src/index.ts' },
      ],
      expectedLanguage: 'JavaScript/TypeScript',
    },
    {
      name: 'Python Project',
      files: [
        { name: 'requirements.txt' },
        { name: 'pyproject.toml' },
        { name: 'main.py' },
      ],
      expectedLanguage: 'Python',
    },
    {
      name: 'Go Project',
      files: [
        { name: 'go.mod' },
        { name: 'main.go' },
      ],
      expectedLanguage: 'Go',
    },
    {
      name: 'Rust Project',
      files: [
        { name: 'Cargo.toml' },
        { name: 'src/main.rs' },
      ],
      expectedLanguage: 'Rust',
    },
  ];

  let passed = 0;
  let failed = 0;

  for (const testCase of testCases) {
    try {
      const stack = await detectProjectStack(testCase.files);
      
      if (stack.language === testCase.expectedLanguage) {
        console.log(`✓ ${testCase.name}: Correctly detected as ${stack.language}`);
        passed++;
      } else {
        console.log(`❌ ${testCase.name}: Expected ${testCase.expectedLanguage}, got ${stack.language}`);
        failed++;
      }
    } catch (error: any) {
      console.log(`❌ ${testCase.name}: ERROR - ${error.message}`);
      failed++;
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  
  if (failed > 0) {
    throw new Error(`Stack detection tests failed: ${failed}/${testCases.length}`);
  }
}

export async function testErrorParsing() {
  console.log('\n╔════════════════════════════════════════════════════╗');
  console.log('║     TESTING ERROR PARSING                          ║');
  console.log('╚════════════════════════════════════════════════════╝');

  const { parseErrors } = require('./universalValidator');

  const errorTestCases = [
    {
      language: 'JavaScript/TypeScript',
      errorOutput: 'src/index.ts:12:5 - error TS2322: Type \'string\' is not assignable to type \'number\'.',
      expectedCount: 1,
      expectedLine: 12,
    },
    {
      language: 'Python',
      errorOutput: 'File "app.py", line 45\n  SyntaxError: invalid syntax',
      expectedCount: 1,
      expectedLine: 45,
    },
    {
      language: 'Go',
      errorOutput: 'main.go:23:5: undefined: fmt',
      expectedCount: 1,
      expectedLine: 23,
    },
    {
      language: 'Rust',
      errorOutput: 'error[E0425]: cannot find value `x` in this scope\n  --> src/main.rs:10:5',
      expectedCount: 1,
      expectedLine: 10,
    },
  ];

  let passed = 0;
  let failed = 0;

  for (const testCase of errorTestCases) {
    try {
      const errors = parseErrors(testCase.errorOutput, testCase.language);
      
      if (errors.length === testCase.expectedCount && errors[0]?.line === testCase.expectedLine) {
        console.log(`✓ ${testCase.language}: Correctly parsed error (Line ${errors[0].line})`);
        passed++;
      } else {
        console.log(`❌ ${testCase.language}: Expected ${testCase.expectedCount} errors at line ${testCase.expectedLine}, got ${errors.length} errors`);
        if (errors.length > 0) {
          console.log(`   First error: Line ${errors[0]?.line}, Message: ${errors[0]?.message}`);
        }
        failed++;
      }
    } catch (error: any) {
      console.log(`❌ ${testCase.language}: ERROR - ${error.message}`);
      failed++;
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  
  if (failed > 0) {
    throw new Error(`Error parsing tests failed: ${failed}/${errorTestCases.length}`);
  }
}
