import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import Anthropic from "@anthropic-ai/sdk";
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from workspace root, falling back to local folder if present
const rootEnvPath = path.resolve(__dirname, '../../.env');
if (fs.existsSync(rootEnvPath)) {
  dotenv.config({ path: rootEnvPath });
} else {
  dotenv.config();
}

const app = express();
app.use(cors());
app.use(express.json());

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY || 'dummy-key-for-mcp-demo', // fallback to avoid crash on init if key not set yet
});

// Determine connection type: 'stdio' or 'sse'
const TRANSPORT_TYPE = process.env.TRANSPORT_TYPE || 'stdio'; 

let mcpClient;

// 1. Initialize and Connect to the MCP Server
async function initMCP() {
  mcpClient = new Client(
    {
      name: "kapruka-web-gateway",
      version: "1.0.0",
    },
    {
      capabilities: {},
    }
  );

  let transport;
  if (TRANSPORT_TYPE === 'stdio') {
    // Start Python MCP Server as a subprocess
    const pythonScriptPath = path.resolve(__dirname, '../../cli.py');
    
    // Resolve the python executable from the virtual environment if it exists
    let pythonCommand = "python";
    const winVenvPython = path.resolve(__dirname, '../../.venv/Scripts/python.exe');
    const unixVenvPython = path.resolve(__dirname, '../../.venv/bin/python');
    
    if (fs.existsSync(winVenvPython)) {
      pythonCommand = winVenvPython;
    } else if (fs.existsSync(unixVenvPython)) {
      pythonCommand = unixVenvPython;
    }
    
    console.log(`Starting Python MCP Server using command: ${pythonCommand}`);
    
    transport = new StdioClientTransport({
      command: pythonCommand,
      args: [pythonScriptPath, "server", "--stdio"],
    });
    console.log("Connecting to Kapruka MCP Server via Stdio...");
  } else {
    // Connect to running FastMCP Server via Server-Sent Events (SSE)
    const mcpUrl = new URL(process.env.KAPRUKA_MCP_URL || "http://localhost:3200/mcp/sse");
    transport = new SSEClientTransport(mcpUrl);
    console.log(`Connecting to Kapruka MCP Server via SSE: ${mcpUrl}`);
  }

  await mcpClient.connect(transport);
  console.log("Kapruka MCP Server connected successfully!");
}

// 2. Chat Endpoint with LLM Agent Loop
app.post('/api/chat', async (req, res) => {
  const { messages } = req.body; // Array of user/assistant messages

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(400).json({ 
      error: "ANTHROPIC_API_KEY is not set. Please add it to your .env file." 
    });
  }

  try {
    // Fetch available tools from the MCP server
    const toolsResponse = await mcpClient.listTools();
    
    // Map MCP tool definition to Anthropic's tool format
    const claudeTools = toolsResponse.tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }));

    // Send context to Anthropic Claude
    let response = await anthropic.messages.create({
      model: "claude-3-5-sonnet-latest",
      max_tokens: 1024,
      system: "You are a helpful shopping assistant for Kapruka.com. Help users search products, estimate delivery rates, and place guest orders using your tools.",
      messages: messages,
      tools: claudeTools,
    });

    // Loop to handle potential multi-step tool invocations
    while (response.stop_reason === "tool_use") {
      const toolCalls = response.content.filter(block => block.type === "tool_use");
      const toolResults = [];

      for (const toolCall of toolCalls) {
        console.log(`Executing tool: ${toolCall.name} with arguments:`, toolCall.input);
        
        try {
          // Invoke the tool on the Kapruka MCP Server
          const toolExecutionResult = await mcpClient.callTool({
            name: toolCall.name,
            arguments: toolCall.input,
          });

          toolResults.push({
            type: "tool_result",
            tool_use_id: toolCall.id,
            content: typeof toolExecutionResult.content === 'string' 
              ? toolExecutionResult.content 
              : JSON.stringify(toolExecutionResult.content),
          });
        } catch (toolError) {
          console.error(`Tool execution error (${toolCall.name}):`, toolError);
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolCall.id,
            content: `Error running tool: ${toolError.message}`,
            is_error: true
          });
        }
      }

      // Add Claude's tool call response and the execution results back to history
      messages.push({ role: "assistant", content: response.content });
      messages.push({ role: "user", content: toolResults });

      // Run Claude again with the tool output results
      response = await anthropic.messages.create({
        model: "claude-3-5-sonnet-latest",
        max_tokens: 1024,
        system: "You are a helpful shopping assistant for Kapruka.com.",
        messages: messages,
        tools: claudeTools,
      });
    }

    // Return the final text response to the front end
    res.json({
      role: "assistant",
      content: response.content[0].text,
    });

  } catch (error) {
    console.error("Chat orchestration error:", error);
    res.status(500).json({ error: `Chat orchestration error: ${error.message}` });
  }
});

const PORT = process.env.PORT || 3000;
initMCP().then(() => {
  app.listen(PORT, () => {
    console.log(`Gateway server running on http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error("Failed to initialize MCP Server:", err);
});
