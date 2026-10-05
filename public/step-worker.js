/* OpenCascade stays off the UI thread. This worker is terminated after each conversion. */
importScripts('/vendor/occt-import-js.js');
self.onmessage = async ({ data }) => {
  try {
    self.postMessage({ status: 'Loading CAD kernel…' });
    const occt = await occtimportjs({ locateFile: file => `/vendor/${file}` });
    self.postMessage({ status: 'Tessellating STEP geometry…' });
    const result = occt.ReadStepFile(new Uint8Array(data.bytes), {
      linearUnit: 'millimeter', linearDeflectionType: 'bounding_box_ratio', linearDeflection: 0.001, angularDeflection: 0.3,
    });
    if (!result.success || !result.meshes?.length) throw new Error('STEP conversion found no supported solid or surface geometry.');
    self.postMessage({ result });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : 'STEP conversion failed.' });
  }
};
