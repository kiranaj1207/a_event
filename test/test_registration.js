/**
 * Verification test suite for IMARTICUS DATATHON 2026 Registration
 */

const { processRegistration, getStoredRegistrations } = require('../lib/registerHandler');

async function runTests() {
  console.log('--- Starting Registration Unit & Integration Tests ---');
  let passed = 0;
  let failed = 0;

  function assert(desc, condition) {
    if (condition) {
      console.log(`  ✓ PASS: ${desc}`);
      passed++;
    } else {
      console.error(`  ✕ FAIL: ${desc}`);
      failed++;
    }
  }

  // Test 1: Missing Required Fields
  const resMissing = await processRegistration({ teamName: '' }, '127.0.0.1');
  assert('Rejects empty team name', resMissing.status === 400 && resMissing.body.success === false);

  // Test 2: Invalid Course
  const resCourse = await processRegistration({
    teamName: 'Cyber Ninjas',
    course: 'B.Sc Physics', // Not in allowed list
    year: '2nd year'
  }, '127.0.0.1');
  assert('Rejects unapproved course', resCourse.status === 400);

  // Test 3: Invalid Phone
  const resPhone = await processRegistration({
    teamName: 'Cyber Ninjas',
    course: 'BCA',
    year: '2nd year',
    leaderName: 'Arun Kumar',
    leaderRegNo: 'BCA202401',
    leaderEmail: 'arun@example.com',
    leaderPhone: '12345', // Invalid
    teamSize: 2,
    members: [{ name: 'Sanjay S', regNo: 'BCA202402' }]
  }, '127.0.0.1');
  assert('Rejects invalid phone number', resPhone.status === 400);

  // Test 4: Member count mismatch
  const resMismatch = await processRegistration({
    teamName: 'Cyber Ninjas',
    course: 'BCA',
    year: '2nd year',
    leaderName: 'Arun Kumar',
    leaderRegNo: 'BCA202401',
    leaderEmail: 'arun@example.com',
    leaderPhone: '9876543210',
    teamSize: 3,
    members: [{ name: 'Sanjay S', regNo: 'BCA202402' }] // Only 1 member for size 3
  }, '127.0.0.1');
  assert('Rejects member count mismatch', resMismatch.status === 400);

  // Test 5: Internal duplicate registration numbers
  const resDupInternal = await processRegistration({
    teamName: 'Cyber Ninjas',
    course: 'BCA',
    year: '2nd year',
    leaderName: 'Arun Kumar',
    leaderRegNo: 'BCA202401',
    leaderEmail: 'arun@example.com',
    leaderPhone: '9876543210',
    teamSize: 3,
    members: [
      { name: 'Sanjay S', regNo: 'BCA202402' },
      { name: 'Rohan M', regNo: 'BCA202401' } // Duplicate of leader
    ]
  }, '127.0.0.1');
  assert('Rejects internal duplicate registration numbers', resDupInternal.status === 400 && resDupInternal.body.message.includes('Duplicate registration number'));

  console.log(`\nTests finished: ${passed} passed, ${failed} failed.`);
}

if (require.main === module) {
  runTests();
}

module.exports = { runTests };
