#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

/**
 * Todo MCP Server
 * A server for managing todos with create, update, and list functionality
 */
class TodoMCPServer {
  private server: Server;

  constructor() {
    this.server = new Server(
      {
        name: 'todo-mcp-server',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();
    this.setupErrorHandler();
  }

  private setupToolHandlers(): void {
    // Handle list tools request
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'create_reminder',
          description: 'Create a new reminder with a title',
          inputSchema: {
            type: 'object',
            properties: {
              title: {
                type: 'string',
                description: 'The title of the reminder',
              },
            },
            required: ['title'],
          },
        },
        {
          name: 'update_reminder',
          description: "Update a reminder's status",
          inputSchema: {
            type: 'object',
            properties: {
              title: {
                type: 'string',
                description: 'The title of the reminder to update',
              },
              status: {
                type: 'string',
                description: 'The new status for the reminder',
                enum: ['pending', 'completed', 'cancelled'],
              },
            },
            required: ['title', 'status'],
          },
        },
        {
          name: 'print_env_variables',
          description: 'Print all environment variables available to the server',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
        {
          name: 'welcome_to_okta',
          description: 'Greet the user with a welcome message to Okta',
          inputSchema: {
            type: 'object',
            properties: {
              userName: {
                type: 'string',
                description: "The user's name for personalized greeting (optional)",
              },
            },
            required: [],
          },
        },
        {
          name: 'list_todos',
          description:
            'Fetch a list of all todos from the API, show only incompleted task unless asked otherwise',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
        {
          name: 'add_todos',
          description: 'Add new todos and it requires a name of todo as string',
          inputSchema: {
            type: 'object',
            properties: {},
            required: ['todoName'],
          },
        },
        {
          name: 'update_todos',
          description:
            'user may ask you to tick it off or get off my plate or Update status of todos requires id and status, convert todoStatus to true or false when calling the tool',
          inputSchema: {
            type: 'object',
            properties: {},
            required: ['id', 'todoStatus'],
          },
        },
      ],
    }));

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      console.error(`🔧 Tool call received: ${name} with args:`, args);

      try {
        if (name === 'create_reminder') {
          console.error('📝 Executing create_reminder tool');
          return await this.createReminder(args as { title: string });
        }
        if (name === 'update_reminder') {
          console.error('📝 Executing update_reminder tool');
          return await this.updateReminder(args as { title: string; status: string });
        }
        if (name === 'print_env_variables') {
          console.error('🔍 Executing print_env_variables tool');
          return this.printEnvVariables();
        }
        if (name === 'welcome_to_okta') {
          console.error('👋 Executing welcome_to_okta tool');
          return this.welcomeToOkta(args as { userName?: string });
        }
        if (name === 'list_todos') {
          console.error('📋 Executing list_todos tool');
          return await this.listTodos();
        }
        if (name === 'add_todos') {
          console.error('📋 Executing add_todos tool');
          return await this.addTodos(args as { todoName: string });
        }
        if (name === 'update_todos') {
          console.error('📋 Executing update_todos tool');
          return await this.updateTodos(args as { id: number; todoStatus: boolean });
        }

        console.error(`❌ Unknown tool: ${name}`);
        throw new Error(`Unknown tool: ${name}`);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
        console.error(`❌ Tool execution error: ${errorMessage}`);
        return {
          content: [
            {
              type: 'text',
              text: `Error: ${errorMessage}`,
            },
          ],
          isError: true,
        };
      }
    });
  }

  private async createReminder(args: { title: string }) {
    try {
      console.error(`Creating reminder: ${args.title}`);

      // Make API call to create reminder
      const response = await fetch('http://localhost:3001/api/reminders', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: args.title,
          status: 'pending',
        }),
      });

      if (!response.ok) {
        throw new Error(`API call failed with status: ${response.status}`);
      }

      const result = await response.json();

      return {
        content: [
          {
            type: 'text',
            text: `✅ Reminder created successfully: "${
              args.title
            }"\nStatus: pending\nResponse: ${JSON.stringify(result, null, 2)}`,
          },
        ],
      };
    } catch (error) {
      // If API call fails, simulate success for demo purposes
      console.error(`Failed to create reminder via API: ${error}`);

      return {
        content: [
          {
            type: 'text',
            text: `✅ Reminder created (simulated): "${args.title}"\nStatus: pending\nNote: API endpoint not available, using mock response`,
          },
        ],
      };
    }
  }

  private async updateReminder(args: { title: string; status: string }) {
    try {
      console.error(`Updating reminder: ${args.title} to status: ${args.status}`);

      // Make API call to update reminder
      const response = await fetch('http://localhost:3001/api/todo/3', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.ACCESS_TOKEN || ''}`,
        },
        body: JSON.stringify({
          title: args.title,
          status: args.status,
        }),
      });

      if (!response.ok) {
        throw new Error(`API call failed with status: ${response.status}`);
      }

      const result = await response.json();

      return {
        content: [
          {
            type: 'text',
            text: `✅ Reminder updated successfully: "${args.title}"\nNew status: ${
              args.status
            }\nResponse: ${JSON.stringify(result, null, 2)}`,
          },
        ],
      };
    } catch (error) {
      // If API call fails, simulate success for demo purposes
      console.error(`Failed to update reminder via API: ${error}`);

      return {
        content: [
          {
            type: 'text',
            text: `✅ Reminder updated (simulated): "${args.title}"\nNew status: ${args.status}\nNote: API endpoint not available, using mock response`,
          },
        ],
      };
    }
  }

  private printEnvVariables() {
    console.error('🔍 Environment variables requested');
    const accessToken = process.env.ACCESS_TOKEN;

    console.error(`📊 ACCESS_TOKEN: ${accessToken || 'NOT SET'}`);

    return {
      content: [
        {
          type: 'text',
          text: `🔐 ACCESS_TOKEN: ${accessToken || 'Not configured'}`,
        },
      ],
    };
  }

  private welcomeToOkta(args?: { userName?: string }) {
    try {
      console.error('👋 Welcome to Okta greeting requested');

      // Get the OKTA_CLIENT_ORGURL environment variable
      const oktaOrgUrl = process.env.OKTA_CLIENT_ORGURL;

      // Create personalized greeting
      const userName = args?.userName;
      const personalizedGreeting = userName ? `Hello ${userName}!` : 'Hello!';

      console.error(`📊 Greeting user: ${userName || 'Anonymous'}`);
      console.error(`📊 OKTA_CLIENT_ORGURL: ${oktaOrgUrl || 'NOT SET'}`);

      const result = {
        content: [
          {
            type: 'text',
            text:
              `🎉 ${personalizedGreeting} Welcome to Okta!\n\n` +
              `🔐 Your Okta Organization: ${oktaOrgUrl || 'Not configured'}\n\n` +
              `✨ We're excited to have you here! Okta provides secure identity and access management solutions.\n\n` +
              `🚀 Ready to get started with your secure authentication journey!`,
          },
        ],
      };

      console.error('✅ Welcome to Okta greeting completed');
      console.error('📤 Returning result:', JSON.stringify(result, null, 2));
      return result;
    } catch (error) {
      console.error(`❌ Failed to generate welcome greeting: ${error}`);

      return {
        content: [
          {
            type: 'text',
            text: `❌ Error generating welcome greeting: ${
              error instanceof Error ? error.message : 'Unknown error'
            }`,
          },
        ],
      };
    }
  }

  private async listTodos() {
    try {
      console.error('📋 Fetching todos from API...');

      // Get ACCESS_TOKEN from environment
      

      // Make API call to fetch todos
      const response = await fetch('http://localhost:3001/api/todos', {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
      });

      if (!response.ok) {
        throw new Error(`API call failed with status: ${response.status}`);
      }

      const todos = await response.json();

      console.error('✅ Todos fetched successfully');
      console.error('📊 Todos data:', JSON.stringify(todos, null, 2));

      return {
        content: [
          {
            type: 'text',
            text: `📋 **Todos List**\n\n${JSON.stringify(todos, null, 2)}\n\n✅ Total todos: ${
              Array.isArray(todos) ? todos.length : 'N/A'
            }`,
          },
        ],
      };
    } catch (error) {
      console.error(`❌ Failed to fetch todos: ${error}`);

      return {
        content: [
          {
            type: 'text',
            text: `❌ Error fetching todos: ${
              error instanceof Error ? error.message : 'Unknown error'
            }\n\nNote: Make sure the API endpoint http://localhost:3001/api/todo is available and ACCESS_TOKEN is valid.`,
          },
        ],
      };
    }
  }

  private async addTodos(todo: { todoName: string }) {
    try {
      console.error('📋 Fetching todos from API...');

      // Get ACCESS_TOKEN from environment
      const accessToken = process.env.ACCESS_TOKEN;
      if (!accessToken) {
        console.error('❌ ACCESS_TOKEN not found in environment');
        return {
          content: [
            {
              type: 'text',
              text: `❌ Error: ACCESS_TOKEN not configured. Cannot fetch todos.`,
            },
          ],
        };
      }

      // Make API call to fetch todos
      const response = await fetch('http://localhost:3001/api/todos', {
        method: 'POST',
        body: JSON.stringify({
          task: todo.todoName,
        }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
      });

      if (!response.ok) {
        throw new Error(`API call failed with status: ${response.status}`);
      }

      const todos = await response.json();

      console.error('✅ Todos fetched successfully');
      console.error('📊 Todos data:', JSON.stringify(todos, null, 2));

      return {
        content: [
          {
            type: 'text',
            text: `📋 **Todos List**\n\n${JSON.stringify(todos, null, 2)}\n\n✅ Total todos: ${
              Array.isArray(todos) ? todos.length : 'N/A'
            }`,
          },
        ],
      };
    } catch (error) {
      console.error(`❌ Failed to fetch todos: ${error}`);

      return {
        content: [
          {
            type: 'text',
            text: `❌ Error fetching todos: ${
              error instanceof Error ? error.message : 'Unknown error'
            }\n\nNote: Make sure the API endpoint http://localhost:3001/api/todo is available and ACCESS_TOKEN is valid.`,
          },
        ],
      };
    }
  }

  private async updateTodos(todo: { id: number; todoStatus: boolean }) {
    try {
      console.error('📋 Fetching todos from API...');

      // Get ACCESS_TOKEN from environment
      const accessToken = process.env.ACCESS_TOKEN;
      if (!accessToken) {
        console.error('❌ ACCESS_TOKEN not found in environment');
        return {
          content: [
            {
              type: 'text',
              text: `❌ Error: ACCESS_TOKEN not configured. Cannot fetch todos.`,
            },
          ],
        };
      }

      // Make API call to fetch todos
      const response = await fetch(`http://localhost:3001/api/todos/${todo.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          id: todo.id,
          completed: todo.todoStatus,
        }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
      });

      if (!response.ok) {
        throw new Error(`API call failed with status: ${response.status}`);
      }

      const todos = await response.json();

      console.error('✅ Todos fetched successfully');
      console.error('📊 Todos data:', JSON.stringify(todos, null, 2));

      return {
        content: [
          {
            type: 'text',
            text: `📋 **Todos List**\n\n${JSON.stringify(todos, null, 2)}\n\n✅ Total todos: ${
              Array.isArray(todos) ? todos.length : 'N/A'
            }`,
          },
        ],
      };
    } catch (error) {
      console.error(`❌ Failed to fetch todos: ${error}`);

      return {
        content: [
          {
            type: 'text',
            text: `❌ Error fetching todos: ${
              error instanceof Error ? error.message : 'Unknown error'
            }\n\nNote: Make sure the API endpoint http://localhost:3001/api/todo is available and ACCESS_TOKEN is valid.`,
          },
        ],
      };
    }
  }

  private setupErrorHandler(): void {
    this.server.onerror = (error) => {
      console.error('[Todo MCP Server Error]', error);
    };

    process.on('SIGINT', async () => {
      console.log('\nShutting down Todo MCP Server...');
      await this.server.close();
      process.exit(0);
    });
  }

  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);

    // This will never resolve - the server runs indefinitely
    console.error('Todo MCP Server running on stdio');
  }
}

// Create and run the server
const server = new TodoMCPServer();
server.run().catch((error: any) => {
  console.error('Failed to run Todo MCP Server:', error);
  process.exit(1);
});
