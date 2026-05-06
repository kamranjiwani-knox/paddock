#!/usr/bin/env bun
import { resolve, dirname } from "path"
import { fileURLToPath } from "url"

// Explicitly load .env from project root (Bun auto-load may miss it when spawned by MCP host)
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const envFile = Bun.file(resolve(projectRoot, ".env"))
if (await envFile.exists()) {
  const text = await envFile.text()
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) continue
    const eqIdx = trimmed.indexOf("=")
    if (eqIdx === -1) continue
    const key = trimmed.slice(0, eqIdx).trim()
    const val = trimmed.slice(eqIdx + 1).trim()
    if (!process.env[key]) process.env[key] = val
  }
}

import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { TOOL_DEFINITIONS, handleToolCall } from "./mcp/server"

const server = new Server(
  {
    name: "paddock",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
)

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOL_DEFINITIONS,
}))

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params

  try {
    const result = await handleToolCall(name, (args ?? {}) as Record<string, unknown>)
    return {
      content: [{ type: "text" as const, text: result }],
    }
  } catch (err) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
        },
      ],
      isError: true,
    }
  }
})

// Start server
const transport = new StdioServerTransport()
await server.connect(transport)
console.error("[paddock] MCP server running on stdio")
