---
description: Create a compiled Form project that can be imported into Mergence
agent: build
---

Use the local `form` and `astra` MCP servers for this demo. Create a low-voltage hardware project with useful mechanical dimensions and component placements for a room-scale Mergence scene.

1. Author a complete Hardware IR project for the user's request, defaulting to a small 5V laboratory temperature monitor if no request is provided.
2. Call `form.opencode.compile_project` to normalize and validate the project. Do not use server-side LLM generation or simulation as a substitute for the MCP compiler.
3. Save the compiled manifest as `demo/form-project.json` in the Mergence checkout using `astra.save_form_project`. Keep the manifest self-contained where possible and do not include credentials, tokens, prompts containing secrets, or server logs.
4. Report the validation summary and tell the user to import `demo/form-project.json` into the running Mergence workbench.

If the Form MCP server is unavailable, stop with the exact local setup requirement rather than silently producing an uncompiled artifact.
