import { EventFixture } from './event-fixture.js';
const fixture = new EventFixture(process.argv[2]!, Number(process.argv[3]));
try {
  fixture.tick(
    100,
    process.argv[4] === 'crash'
      ? () => {
          process.stdout.write('before-commit\n');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        }
      : undefined,
  );
} finally {
  fixture.db.close();
}
