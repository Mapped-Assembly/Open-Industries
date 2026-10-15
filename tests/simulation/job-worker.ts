import { JobFixture } from './job-fixture.js';

const fixture = new JobFixture(process.argv[2]!, Number(process.argv[3]));
try {
  const result = fixture.tick(
    100,
    process.argv[4] === 'crash'
      ? () => {
          process.stdout.write('before-commit\n');
          // Parent kills this process while its SQLite transaction is still open.
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        }
      : undefined,
  );
  process.stdout.write(JSON.stringify(result));
} finally {
  fixture.db.close();
}
