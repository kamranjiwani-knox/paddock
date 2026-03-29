#!/usr/bin/env bun
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
