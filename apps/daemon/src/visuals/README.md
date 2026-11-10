# Visuals

The Visuals setting (ENG-597, ADR 0101): how readily agents reach for the `visualize` tool on the Polaris MCP (`../mcp/tools/visualize.ts`). Its level is `rich` (the default), `simple` or `off`.

- **Protocol** (`@polaris/protocol` `visuals.ts`, capability `sessions.visuals`): `sessions.visuals` returns `VisualsSettings { level }`; `sessions.setVisuals { settings }` replaces it. Both need the `client` grant and are `local` only for Linked Devices. The Desktop App keeps the user's choice and writes it to each Host, as it does for idle compaction.
- **Storage**: `~/.polaris/visuals-settings.json`, written atomically. A missing or unreadable file reads as `rich`. Every read goes to the file, so the RPC handlers and the Constellation attachments agree without sharing an instance.
- **When it applies**: when an Agent Session's Harness opens (a new session, or a reopen after a Daemon restart or a Harness exit), `../constellation/composition/provider.ts` reads the level and passes it to `attachConstellation`. `off` leaves `visualize` out of the catalog and drops the guidance; `rich` and `simple` choose the guidance appended to the shared preamble (`@polaris/visualization`'s `visualizeGuidance`). A session whose Harness is already open keeps its catalog and guidance on its next Turn.
