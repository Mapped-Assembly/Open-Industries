import { ResourceFixture } from './resource-fixture.js';
const fixture = new ResourceFixture(process.argv[2]);
try {
  process.stdout.write(
    JSON.stringify({ ok: true, result: fixture.run(JSON.parse(process.argv[3])) }),
  );
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
