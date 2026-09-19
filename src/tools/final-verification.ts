import { verifyImplementation, verifyExports, testStackDetection, testErrorParsing } from './debug-validator';

export async function runFinalVerification() {
  console.log('╔════════════════════════════════════════════════════╗');
  console.log('║   FINAL BULLETPROOF VERIFICATION SUITE             ║');
  console.log('╚════════════════════════════════════════════════════╝\n');

  const tests = [
    { name: 'File Existence', fn: verifyImplementation },
    { name: 'Export Verification', fn: verifyExports },
    { name: 'Stack Detection', fn: testStackDetection },
    { name: 'Error Parsing', fn: testErrorParsing },
  ];

  let passed = 0;
  let failed = 0;

  for (const test of tests) {
    try {
      console.log(`\n🧪 Running: ${test.name}...`);
      await test.fn();
      passed++;
    } catch (error: any) {
      console.error(`\n❌ FAILED: ${test.name}`);
      console.error(`   ${error.message}`);
      failed++;
    }
  }

  console.log('\n╔════════════════════════════════════════════════════╗');
  console.log(`║   FINAL RESULTS: ${passed} Passed, ${failed} Failed          ║`);
  console.log('╚════════════════════════════════════════════════════╝');

  if (failed > 0) {
    throw new Error(`${failed} tests failed. Fix immediately.`);
  }

  console.log('\n✅ ALL VERIFICATION TESTS PASSED');
  console.log('Implementation is BULLETPROOF');
}

runFinalVerification().catch(e => {
  console.error('\n🚨 VERIFICATION FAILED');
  console.error(e.message);
  process.exit(1);
});
