import { readFileSync, writeSync } from 'node:fs';
import { startFieldLabService } from '../../server/field-lab-service.js';
import { FieldLabDatabase } from '../../server/simulation/field-lab-runtime.js';
const [role, path, timeFile, token, request] = process.argv.slice(2);
/** Test-only authoritative clock fixture; production has no HTTP clock setter. */
const clock = () => Number(readFileSync(timeFile!, 'utf8'));
if (role === 'service') {
  const service = await startFieldLabService({
    database: path!,
    port: 0,
    allowSignup: true,
    clock,
    tickMs: 50,
  });
  process.stdout.write(service.origin + '\n');
} else {
  const db = new FieldLabDatabase(path!, { clock });
  if (role === 'kill-before-commit')
    db.tick(() => {
      writeSync(1, 'KILL_BEFORE_COMMIT\n');
      process.kill(process.pid, 'SIGKILL');
    });
  else {
    try {
      process.stdout.write(
        JSON.stringify({ ok: true, result: db.execute(token!, JSON.parse(request!)) }),
      );
    } catch (error) {
      process.stdout.write(JSON.stringify({ ok: false, code: (error as { code?: string }).code }));
    } finally {
      db.close();
    }
  }
}
