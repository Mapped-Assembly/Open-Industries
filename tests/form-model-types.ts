// Compile-only consumer contracts: known fields must never regress to unknown/any.
import type { FormIR, FormArtifact } from '../src/lib/form-model';
export function typedImportConsumer(ir: FormIR, artifact: FormArtifact) {
  const title: string | undefined = ir.overview?.title;
  const quantity: number | undefined = ir.bom?.[0].quantity;
  const pin: string | undefined = ir.nets?.[0].pins?.[0].pin_id;
  const size: number | undefined = ir.mechanical?.component_placements?.[0].size.x_mm;
  const agent: string | undefined = ir.assembly_metadata?.source_agent;
  const hash: string | undefined = artifact.sha256;
  // @ts-expect-error Known numeric fields cannot accept strings.
  const invalidBOM: FormIR = { bom: [{ quantity: 'one' }] };
  // @ts-expect-error Nested geometry fields have explicit vector types.
  const invalidSize: FormIR = { mechanical: { render_dimensions: { x_mm: '10', y_mm: 10, z_mm: 10 } } };
  // @ts-expect-error Provenance identifiers are strings.
  const invalidAgent: FormIR = { assembly_metadata: { source_agent: false } };
  return { title, quantity, pin, size, agent, hash, invalidBOM, invalidSize, invalidAgent };
}
