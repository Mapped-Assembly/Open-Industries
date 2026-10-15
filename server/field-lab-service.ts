import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startSimulationService } from './simulation-service.js';
/** Real lab service uses the shared authenticated HTTP boundary and its own schema-101 database. */
export function startFieldLabService(options: Parameters<typeof startSimulationService>[0]) {
  return startSimulationService({ ...options, domain: 'field-lab' });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.ASTRA_FIELD_LAB_PORT ?? 8792);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error('INVALID_FIELD_LAB_PORT');
  const service = await startFieldLabService({
    database: resolve(process.env.ASTRA_FIELD_LAB_DB ?? '.astra/simulation/field-lab.sqlite'),
    port,
    allowSignup: process.env.ASTRA_FIELD_LAB_ALLOW_SIGNUP === 'true',
  });
  console.log(`OpenIndustries field-lab service: ${service.origin}`);
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, () => {
      service.close().then(() => process.exit(0));
    });
}
