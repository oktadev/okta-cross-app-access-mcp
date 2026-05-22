import {
  BedrockRuntimeClient,
  InvokeModelCommand,
  InvokeModelCommandInput,
} from '@aws-sdk/client-bedrock-runtime';
import { fromEnv } from '@aws-sdk/credential-providers';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DEFAULT_MODEL, DEFAULT_REGION, SYSTEM_PROMPT } from './config.js';
import { logger } from './logger.js';
import { BedrockClientConfig, ChatMessage, MCPServerConfig } from './types.js';

export class MCPBedrockClient {
  private bedrockClient: BedrockRuntimeClient;

  private mcpClients: Map<string, Client> = new Map();

  private modelId: string;

  private conversationHistory: ChatMessage[] = [];

  constructor(config: BedrockClientConfig = {}) {
    this.bedrockClient = new BedrockRuntimeClient({
      region: config.region || process.env.AWS_REGION || DEFAULT_REGION,
      credentials: fromEnv(),
    });
    this.modelId = config.modelId || process.env.BEDROCK_MODEL_ID || DEFAULT_MODEL;

    logger.info('Initialized Agent0 MCP Client', {
      region: config.region || process.env.AWS_REGION || DEFAULT_REGION,
      modelId: this.modelId,
    });
  }

  /**
   * Connect to an MCP server
   */
  async connectToMCPServer(serverConfig: MCPServerConfig): Promise<void> {
    try {
      logger.loading(`Connecting to MCP server: ${serverConfig.name}`);

      // Create transport for the MCP server
      const transport = new StdioClientTransport({
        command: serverConfig.command,
        args: serverConfig.args || [],
        env: serverConfig.env,
      });

      // Create MCP client
      const client = new Client(
        {
          name: 'agent0',
          version: '1.0.0',
        },
        {
          capabilities: {},
        },
      );

      // Connect to the server
      await client.connect(transport);

      // Store the client
      this.mcpClients.set(serverConfig.name, client);

      logger.success(`Successfully connected to MCP server: ${serverConfig.name}`);

      // List available tools
      const tools = await client.listTools();
      logger.mcpEvent(serverConfig.name, 'tools_discovered', {
        count: tools.tools?.length || 0,
        tools: tools.tools?.map((t) => t.name) || [],
      });
    } catch (error) {
      logger.error(`Failed to connect to MCP server ${serverConfig.name}`, error);
      throw error;
    }
  }

  /**
   * Disconnect from an MCP server
   */
  async disconnectFromMCPServer(serverName: string): Promise<void> {
    const client = this.mcpClients.get(serverName);
    if (client) {
      await client.close();
      this.mcpClients.delete(serverName);
      logger.success(`Disconnected from MCP server: ${serverName}`);
    }
  }

  /**
   * List all available tools from connected MCP servers
   */
  async listAllTools(): Promise<Record<string, any[]>> {
    const allTools: Record<string, any[]> = {};

    for (const [serverName, client] of this.mcpClients) {
      try {
        const result = await client.listTools();
        allTools[serverName] = result.tools || [];
      } catch (error) {
        logger.error(`Error listing tools from ${serverName}`, error);
        allTools[serverName] = [];
      }
    }

    return allTools;
  }

  /**
   * Call a tool on a specific MCP server
   */
  async callTool(serverName: string, toolName: string, args: any): Promise<any> {
    const client = this.mcpClients.get(serverName);
    if (!client) {
      throw new Error(`MCP server "${serverName}" not connected`);
    }

    try {
      logger.toolCall(serverName, toolName, args);

      const result = await client.callTool({
        name: toolName,
        arguments: args,
      });

      logger.toolResult(serverName, toolName, result);
      return result;
    } catch (error) {
      logger.error(`Error calling tool ${toolName} on ${serverName}`, error);
      throw error;
    }
  }

  /**
   * Send a message to Claude via Bedrock and process any tool calls
   */
  async sendMessage(message: string): Promise<string> {
    try {
      // Add user message to conversation history
      this.conversationHistory.push({
        role: 'user',
        content: message,
        timestamp: new Date(),
      });

      // Get available tools
      const allTools = await this.listAllTools();
      const toolsDescription = this.formatToolsForClaude(allTools);

      // Prepare the prompt with tool information
      const systemPrompt = `${SYSTEM_PROMPT}\n\n${toolsDescription}`;

      // Prepare conversation for Claude
      const conversationText = this.conversationHistory
        .map((msg) => `${msg.role}: ${msg.content}`)
        .join('\n\n');

      const fullPrompt = `${systemPrompt}\n\nConversation:\n${conversationText}\n\nassistant:`;

      // Call Claude via Bedrock
      const input: InvokeModelCommandInput = {
        modelId: this.modelId,
        body: JSON.stringify({
          anthropic_version: 'bedrock-2023-05-31',
          max_tokens: 4000,
          messages: [
            {
              role: 'user',
              content: fullPrompt,
            },
          ],
        }),
        contentType: 'application/json',
        accept: 'application/json',
      };

      const command = new InvokeModelCommand(input);
      const response = await this.bedrockClient.send(command);

      if (!response.body) {
        throw new Error('No response body from Bedrock');
      }

      const responseBody = JSON.parse(new TextDecoder().decode(response.body));

      let assistantMessage = responseBody.content[0].text;

      // Check if Claude wants to use a tool
      try {
        // First try to parse the entire message as JSON
        const toolRequest = JSON.parse(assistantMessage);
        if (toolRequest.action === 'tool_call') {
          console.log(`Calling tool: ${toolRequest.tool} on server: ${toolRequest.server}`);

          const toolResult = await this.callTool(
            toolRequest.server,
            toolRequest.tool,
            toolRequest.arguments,
          );

          // Send tool result back to Claude
          const followUpPrompt = `The tool "${toolRequest.tool}" returned: ${JSON.stringify(
            toolResult,
            null,
            2,
          )}\n\nPlease provide a natural language response based on this information.`;

          const followUpInput: InvokeModelCommandInput = {
            modelId: this.modelId,
            body: JSON.stringify({
              anthropic_version: 'bedrock-2023-05-31',
              max_tokens: 4000,
              messages: [
                {
                  role: 'user',
                  content: followUpPrompt,
                },
              ],
            }),
            contentType: 'application/json',
            accept: 'application/json',
          };

          const followUpCommand = new InvokeModelCommand(followUpInput);
          const followUpResponse = await this.bedrockClient.send(followUpCommand);

          if (followUpResponse.body) {
            const followUpBody = JSON.parse(new TextDecoder().decode(followUpResponse.body));
            assistantMessage = followUpBody.content[0].text;
          }
        }
      } catch (error) {
        // If full message isn't JSON, try to extract JSON from the message
        try {
          const jsonMatch = assistantMessage.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const toolRequest = JSON.parse(jsonMatch[0]);
            if (toolRequest.action === 'tool_call') {
              console.log(`Calling tool: ${toolRequest.tool} on server: ${toolRequest.server}`);

              const toolResult = await this.callTool(
                toolRequest.server,
                toolRequest.tool,
                toolRequest.arguments,
              );

              // Send tool result back to Claude
              const followUpPrompt = `The tool "${toolRequest.tool}" returned: ${JSON.stringify(
                toolResult,
                null,
                2,
              )}\n\nPlease provide a natural language response based on this information.`;

              const followUpInput: InvokeModelCommandInput = {
                modelId: this.modelId,
                body: JSON.stringify({
                  anthropic_version: 'bedrock-2023-05-31',
                  max_tokens: 4000,
                  messages: [
                    {
                      role: 'user',
                      content: followUpPrompt,
                    },
                  ],
                }),
                contentType: 'application/json',
                accept: 'application/json',
              };

              const followUpCommand = new InvokeModelCommand(followUpInput);
              const followUpResponse = await this.bedrockClient.send(followUpCommand);

              if (followUpResponse.body) {
                const followUpBody = JSON.parse(new TextDecoder().decode(followUpResponse.body));
                assistantMessage = followUpBody.content[0].text;
              }
            }
          }
        } catch (innerError) {
          // Not a tool call, continue with normal response
        }
      }

      // Add assistant response to conversation history
      this.conversationHistory.push({
        role: 'assistant',
        content: assistantMessage,
        timestamp: new Date(),
      });

      return assistantMessage;
    } catch (error) {
      logger.error('Error sending message to Bedrock', error);
      throw error;
    }
  }

  /**
   * Format available tools for Claude's understanding
   */
  private formatToolsForClaude(allTools: Record<string, any[]>): string {
    let description = '';

    for (const [serverName, tools] of Object.entries(allTools)) {
      if (tools.length > 0) {
        description += `\nServer: ${serverName}\n`;
        for (const tool of tools) {
          description += `- ${tool.name}: ${tool.description || 'No description'}\n`;
          if (tool.inputSchema) {
            description += `  Parameters: ${JSON.stringify(tool.inputSchema, null, 2)}\n`;
          }
        }
      }
    }

    return description || 'No tools available.';
  }

  /**
   * Clear conversation history
   */
  clearHistory(): void {
    this.conversationHistory = [];
  }

  /**
   * Get conversation history
   */
  getHistory(): ChatMessage[] {
    return [...this.conversationHistory];
  }

  /**
   * Disconnect from all MCP servers
   */
  async disconnect(): Promise<void> {
    const disconnectPromises = Array.from(this.mcpClients.keys()).map((serverName) =>
      this.disconnectFromMCPServer(serverName),
    );
    await Promise.all(disconnectPromises);
  }
}
