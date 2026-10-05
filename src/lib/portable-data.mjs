// Portable artifacts retain authoring identity and hardware, not the environment
// that ran the authoring agent. Normalize spelling, never the retained field names.
const normalized = key => key.replace(/[^a-z0-9]/gi, '').toLowerCase();
const runtimeContainers = new Set([
  'runtimeconfig', 'runtimeconfiguration', 'runtimesettings',
  'providerconfig', 'providerconfiguration', 'providersettings', 'providers',
  'modelconfig', 'modelconfiguration', 'modelsettings',
  'llm', 'llmconfig', 'llmconfiguration', 'llmsettings',
  'inferenceconfig', 'inferencesettings',
]);
const runtimeFields = new Set([
  'provider', 'providerid', 'providername', 'llmprovider', 'modelprovider',
  'modelid', 'modelname', 'llmmodel', 'basemodel', 'defaultmodel',
  'baseurl', 'apibase', 'apibaseurl', 'providerurl', 'providerbaseurl',
  'llmbaseurl', 'llmendpoint', 'apiendpoint', 'providerendpoint',
]);
const authoringRecords = new Set([
  'formproject', 'sourcedocument', 'response', 'result', 'project',
  'projectir', 'hardwareir', 'ir', 'projectobject', 'assemblymetadata',
  'authoring', 'provenance', 'metadata', 'meta',
]);

/** Return a sanitized JSON copy; never mutate source geometry or provenance. */
export function scrubPortableData(value) {
  function visit(item, authoring = true) {
    if (Array.isArray(item)) return item.map(value => visit(value, authoring));
    if (!item || typeof item !== 'object') return item;
    const namespaceMetadata = item.name === 'project.meta';
    const runtimeRecord = Object.keys(item).some(key => runtimeFields.has(normalized(key)) || runtimeContainers.has(normalized(key)));
    return Object.fromEntries(Object.entries(item).flatMap(([key, child]) => {
      const field = normalized(key);
      if (/(apikey|secret|password|credential|authorization|token)/.test(field)
          || runtimeContainers.has(field) || runtimeFields.has(field)
          || ((authoring || runtimeRecord) && ['model', 'endpoint', 'temperature'].includes(field))) return [];
      const context = authoringRecords.has(field) || (namespaceMetadata && field === 'payload');
      return [[key, visit(child, context)]];
    }));
  }
  return visit(value);
}
