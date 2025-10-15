#!/usr/bin/env node

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import dotenv from 'dotenv';
import * as path from 'path';
import { HITLApprovalService } from '../HITLApprovalService';

type MCPServerConfig = {
    command: string;
    args: string[];
    env: Record<string, string>;
    HighRiskTools: string[];
    BlockedTools: string[]
};

const mcpClient = new Client({
  name: "HITL-client",
  version: "1.0.0"
});

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
  // other properties like annotations, outputSchema (optional)
}

const APPROVAL_FILE_PATH = path.join(process.cwd(), 'hitl_approvals.json');

/**
 * HITL MCP Server
 * Human in the loop MCP Proxy
 */
class HITLProxy {
  private server: Server;
  private readonly downstreamServerName: string;
  private downstreamClient: Client;
  private hitlApprovalService: HITLApprovalService;

  private pendingTasks: Map<string, {
      toolName: string;
      toolArgs: any;
      status: 'PENDING' | 'APPROVED' | 'DENIED';
      hitlOobCode?: string;
      // Add a property to hold the initial request ID if needed for later reference
      // requestId: number;
  }> = new Map();

  private static readonly MCPServerMap: Record<string, MCPServerConfig> = {
      "todo-mcp-server": { // <--- This is now a simple object
          command: "/usr/bin/node",
          args: ["dist/mcp-server/todo-mcp-server.js"],
          env: { ACCESS_TOKEN: `${process.env.ACCESS_TOKEN}` },
          HighRiskTools: ["add_todos"],
          BlockedTools: ["welcome_to_okta"]
      },
      // ... other server configs
  };

  public static async create(serverName: string): Promise<HITLProxy> {
        const instance = new HITLProxy(serverName);
        await instance.initializeDownstreamConnection();
        return instance;
    }

  private constructor(MCPServerName: string) {
    // const currentServerName = MCPServerName;
    this.downstreamServerName = MCPServerName;

    this.hitlApprovalService = new HITLApprovalService();


    this.downstreamClient = new Client({
            name: `${MCPServerName}-client`,
            version: '1.0.0'
        });

    this.server = new Server(
      {
        name: MCPServerName,
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {}
        },
      }
    );

    this.setupToolHandlers();
    this.setupErrorHandler();
  }

   private async initializeDownstreamConnection(): Promise<void> {
        const config = HITLProxy.MCPServerMap[this.downstreamServerName];
        if (!config) {
            throw new Error(`Transport config for ${this.downstreamServerName} not found.`);
        }

        const transport = new StdioClientTransport(config);

        console.log(`[HITLProxy] Establishing persistent connection to ${this.downstreamServerName}`);

        // Connect ONCE and keep the connection live for the lifetime of the proxy
        await this.downstreamClient.connect(transport);
        console.log("Downstream client connected successfully!");
    }

  private async getTools(): Promise<ToolDefinition[]> {

    const config = HITLProxy.MCPServerMap[this.downstreamServerName];
    if (!config) {
        console.error(`Transport config for ${this.downstreamServerName} not found.`);
        return [];
    }

    const transport = new StdioClientTransport(config);

    try {
      console.log(`[HITLProxy] Connecting to ${this.downstreamServerName}`);

      const toolsResult = await this.downstreamClient.listTools();
      return toolsResult.tools as ToolDefinition[];

    } catch (error) {
      console.error("Connection failed:", error);
    }
    return [];
  }

  private async callTool(toolName: string, toolargs: any, progressToken: string | number | undefined): Promise<any> {
    const config = HITLProxy.MCPServerMap[this.downstreamServerName];
    if (!config) return null;

    // Check if tools is blocked
    if(HITLProxy.MCPServerMap[this.downstreamServerName].BlockedTools.includes(toolName))
    {
      console.error(`❌ Access to ${toolName} has been blocked.`);
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `❌ Access to ${toolName} has been blocked.`,
            },
          ],
        };
    }

    // Check if tool is High Risk
    if(HITLProxy.MCPServerMap[this.downstreamServerName].HighRiskTools.includes(toolName))
    {

      const taskId = `task-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
      let oobCode: string;

      try {
          // 🆕 NEW: Initiate Okta Push Notification and get the OOB Code
          console.log(`[HITL] Initiating Okta approval for ${toolName} by sending push to "bob@tables.fake"...`);
          oobCode = await this.hitlApprovalService.sendApprovalRequest("bob@tables.fake");
          console.log(`[HITL] Okta OOB Code received for taskId ${taskId}.`);

      } catch (error: any) {
          console.error(`[HITL] Failed to initiate Okta approval for ${toolName}:`, error.message);
          return {
              isError: true,
              content: [{ type: 'text', text: `Authorization setup failed: ${error.message}` }],
          };
      }
      console.error(`[HITL] Tool Added to pendingTasks: Toolname: ${toolName}. ToolArgs: ${JSON.stringify(toolargs)}`)
      this.pendingTasks.set(taskId, {
          toolName: toolName,
          toolArgs: toolargs,
          status: 'PENDING',
          hitlOobCode: oobCode,
      });

      if (progressToken) {
         console.error(`🔒 Approval required for ${toolName}.Args: ${JSON.stringify(toolargs)}. Token: ${progressToken}`);
        await this.server.notification({
            method: 'notifications/progress',
            params: {
                progressToken: progressToken,
                progress: 10,
                total: 100,
                message: `Awaiting Approval for High Risk Task`,
            }
        });
      }

        // Automatically poll for approval instead of returning immediately
        console.log(`[HITL] Starting automatic approval polling for task ${taskId}...`);

        const startTime = Date.now();
        const pollTimeout = 30000; // 30 seconds total timeout
        const pollInterval = 4000; // Check every 4 seconds

        while (Date.now() - startTime < pollTimeout) {
            try {
                const approvalStatus = await this.hitlApprovalService.checkForApproval(oobCode);

                if (approvalStatus === "APPROVED") {
                    console.log(`[HITL] Task ${taskId} APPROVED! Executing tool ${toolName}...`);

                    // Execute the actual tool now that it's approved
                    const toolResult = await this.downstreamClient.callTool({
                        name: toolName,
                        arguments: toolargs
                    });

                    // Clean up the pending task
                    this.pendingTasks.delete(taskId);

                    // Return the actual tool result
                    return toolResult;
                }

                // Still pending, wait before next poll
                console.log(`[HITL] Task ${taskId} still pending, waiting ${pollInterval}ms before next check...`);
                await new Promise(resolve => setTimeout(resolve, pollInterval));

            } catch (error: any) {
                // If denied or other error, clean up and return error
                console.error(`[HITL] Approval check failed: ${error.error_description || error.message}`);
                this.pendingTasks.delete(taskId);

                return {
                    isError: true,
                    content: [{
                        type: 'text',
                        text: `❌ Approval was denied or failed: ${error.error_description || error.message}`,
                    }],
                };
            }
        }

        // Timeout - approval took too long
        console.error(`[HITL] Task ${taskId} timed out waiting for approval`);
        this.pendingTasks.delete(taskId);

        return {
            isError: true,
            content: [{
                type: 'text',
                text: `⏱️ Approval request timed out after ${pollTimeout / 1000} seconds. Please try again.`,
            }],
        };

    }

    try {
      console.log("Connected successfully!");

      const toolsResult = await this.downstreamClient.callTool({ name: toolName, arguments: toolargs });
      return toolsResult;

    } catch (error) {
      console.error("Connection failed:", error);
    }
    return null;
  }


  private setupToolHandlers(): void {
    console.log('Setting up tools...');
    // Handle list tools request
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      console.log(`[HITLProxy] Call List Tools for ${this.downstreamServerName}`);
      const downstreamTools = await this.getTools();
      const checkStatusToolDefinition: ToolDefinition = {
        name: 'check_task_status',
        description: 'Checks the current approval status of a previously requested high-risk task using its Task ID. Required for Human-In-The-Loop tasks.',
        inputSchema: {
            type: 'object',
            properties: {
                taskId: {
                    type: 'string',
                    description: 'The unique Task ID returned in the structured content of the pending tool call.'
                }
            },
            required: ['taskId']
        }
      };
      const ListHighRiskToolDefinition: ToolDefinition = {
        name: 'list_high_risk_tools',
        description: 'Displays a list of "High Risk" tools that require approval as part of Human-In-The-Loop tasks.',
        inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
      };

      return { tools: [...downstreamTools, checkStatusToolDefinition, ListHighRiskToolDefinition ]};
    });

    // Handle tool call request
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      console.error(`[HITL] CallToolRequest called with params: ${JSON.stringify(request.params)}`)
      const { name, arguments: args, _meta } = request.params;
      console.log(`[HITLProxy] Call Tool ${name} for ${this.downstreamServerName}`);
      const progressToken = _meta?.progressToken;
      // Specific Task for Checkking approval
      if (name === 'check_task_status') {
        if (!args || typeof args.taskId !== 'string') {
              return {
                  content: [{ type: 'text', text: 'Error: check_task_status requires a valid taskId argument.' }],
              };
          }
          const startTime = Date.now();
          var lastresult;
          while (Date.now() < (startTime + 10000)) { // 30000
            const result = await this.handleTaskStatusCheck(args.taskId);
            lastresult = result ?? lastresult;
            const status = result?.structuredContent?.status;
             if (status && status !== 'PENDING') {
              return result;
             }
             await new Promise(r => setTimeout(r, 4000));
          }
          return lastresult;
      }
      if(name === 'list_high_risk_tools')
      {
         return {
                  content: [
                    { type: 'text',
                      text: `High risk tools are ${JSON.stringify(HITLProxy.MCPServerMap[this.downstreamServerName].HighRiskTools)}.`
                    }],
              };
      }

      return this.callTool(name, request.params.arguments, progressToken);
    });
  }

  private async handleTaskStatusCheck(taskId: string): Promise<any> {
      const task = this.pendingTasks.get(taskId);

      if (!task || !task.hitlOobCode) {
          console.error(`[HITL] Error: Task ID ${taskId} not found or missing OOB code.`);
          return {
              content: [{ type: 'text', text: `Error: No active task found with ID ${taskId}. It may have already expired or been completed.` }],
          };
      }

      console.error(`[HITL] Polling Okta status for Task ${taskId} using OOB code...`);

      try {
          if(await this.hitlApprovalService.checkForApproval(task.hitlOobCode) == "APPROVED")
          {
            // If checkForApproval succeeds (no error thrown), the task is APPROVED
            console.error(`[HITL] Task ${taskId} is APPROVED (via Okta). Executing downstream tool: ${task.toolName}`);

            const toolsResult = await this.downstreamClient.callTool({
                name: task.toolName,
                arguments: task.toolArgs
            });

            this.pendingTasks.delete(taskId);

            //return toolsResult;
            return {
                ...toolsResult, // Include the actual tool output
                structuredContent: {
                    status: 'COMPLETED', // Use a defined non-PENDING status
                    tool: task.toolName
                }
            };
          }else{ // If not approved it will be PENDING as error will throw
            console.warn(`[HITL] Task ${taskId} is still PENDING Okta approval.`);
            return {
                content: [{ type: 'text', text: `Task ${taskId} is still PENDING human approval. Please wait and check again.` }],
                structuredContent: { status: 'PENDING', tool: task.toolName }
            };
          }

      } catch (error: any) {

          // Handle all other errors (Denied, Expired, Network failure)
          console.error(`[HITL] Task ${taskId} failed or was DENIED by Okta. Error: ${error.error_description || error.message}`);
          this.pendingTasks.delete(taskId); // Clean up the failed/denied task

          return {
              isError: true,
              content: [{
                  type: 'text',
                  text: `Task ${taskId} approval failed or was denied. Status: ${error.error || 'DENIED/FAILED'}.`
              }],
          };
      }
  }


  private setupErrorHandler(): void {
    this.server.onerror = (error) => {
      console.error('[HITL Proxy Error]', error);
    };

    process.on('SIGINT', async () => {
      console.log('\nShutting down Todo MCP Server...');
      await this.server.close();
      await this.downstreamClient.close();
      process.exit(0);
    });
  }

  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }
}

var MCPServername = "MCPServer";
if (process.argv.length > 2) {
  MCPServername = process.argv[2]
}

dotenv.config();

// Create and run the server
HITLProxy.create(MCPServername)
    .then(serverInstance => {
        return serverInstance.run();
    })
    .catch((error: any) => {
        console.error('Failed to run HITL Proxy:', error);
        process.exit(1);
    });

