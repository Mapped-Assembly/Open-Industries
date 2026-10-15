import { CommandFixture } from './command-fixture.js';
const fixture = new CommandFixture(process.argv[2]);
try {
  const result = fixture.execute(JSON.parse(process.argv[3]));
  process.stdout.write(JSON.stringify({ ok: true, result }));
} catch (error) {
  process.stdout.write(
    JSON.stringify({
      ok: false,
      code: error instanceof Error && 'code' in error ? error.code : 'UNEXPECTED',
    }),
  );
} finally {
  fixture.db.close();
}
