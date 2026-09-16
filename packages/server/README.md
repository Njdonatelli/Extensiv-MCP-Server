# extensiv-mcp-server

MCP server for [Extensiv 3PL Warehouse Manager](https://www.extensiv.com/). Sixteen task-shaped tools, read-only by default, two-phase audited writes.

Install and check the connection (Bash/Zsh):

```bash
npm install -g extensiv-mcp-server
EXTENSIV_BASE_URL=https://secure-wms.com \
EXTENSIV_CLIENT_ID=… \
EXTENSIV_CLIENT_SECRET=… \
EXTENSIV_USER_LOGIN=… \
extensiv-mcp --check
```
Expected output: JSON with `"ok": true` and the environment label of the base URL you pointed at.

`extensiv-mcp --help` lists every environment variable. `extensiv-mcp --print-config` prints the effective configuration with secrets redacted.

Register it with an MCP client by running `extensiv-mcp` over stdio, or set `EXTENSIV_MCP_TRANSPORT=http` for Streamable HTTP on `EXTENSIV_MCP_HTTP_PORT`.

**Writes are off unless you turn them on.** `EXTENSIV_MCP_WRITES_ENABLED=true` additionally requires an explicit `EXTENSIV_MCP_WRITE_CUSTOMER_IDS` allow-list, or startup fails. With writes off, the five write tools are not registered at all.

Full documentation, the safety model, the credential runbook and the verification status live in the [repository](https://github.com/Njdonatelli/MCP-Server-Extensiv).
