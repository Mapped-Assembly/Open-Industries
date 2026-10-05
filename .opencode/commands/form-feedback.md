---
description: Apply the latest Mergence animation review to the Form project
agent: build
---

Call `astra.read_animation_feedback` from the local Mergence MCP server. If it is missing, ask the user to render an authored timeline animation and use Mergence's **Send feedback to Form** action first.

1. Inspect the feedback instruction, room context, sampled animation frames, and referenced Form project identity.
2. Call `astra.read_form_project` for the corresponding `demo/form-project.json` or other local compiled Form manifest. Preserve the existing electrical design unless the feedback explicitly requires a change.
3. Apply the requested mechanical or workflow change to the project IR and call `form.opencode.update_project` to validate and persist the revised Form project.
4. Call `astra.save_form_project` with the returned `project_ir` so the revised artifact is ready for Mergence.
5. Report validation findings and tell the user to reimport the revised Form JSON into Mergence and rerun the animation review.

Never claim that animation feedback was applied if the Form MCP tool is unavailable or validation fails.
