import authtoken from './server/controllers/authtoken.js';
import { MCPServerConfig } from './types.js';

export async function getAccessToken(cookie: any): Promise<any> {
  try {
    console.log('🔑 Fetching access token from API...');
    console.log(`cookie is ${cookie}`);
    const AGENT_SERVER = process.env.AGENT_SERVER;
    const response = await fetch(`${AGENT_SERVER}/api/tokens`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
    });
    if (!response.ok) {
      console.error(`❌ Failed to fetch access token, status: ${response.status}`);
      console.error(`❌ Failed to fetch AUTH: ${authtoken}`);
      return '';
    }

    const tokenData = (await response.json()) as any;

    console.log('📋 Token data received:', tokenData);

    // Handle different response formats
    if (tokenData.tokens && tokenData.tokens.length > 0) {
      const accessToken = tokenData.tokens[0].accessToken || '';
      console.log('✅ Access token found in tokens array');
      return accessToken;
    }
    if (tokenData.responseBody && tokenData.responseBody.access_token) {
      const accessToken = tokenData.responseBody.access_token;
      console.log('✅ Access token found in responseBody');
      return accessToken;
    }
    if (tokenData.access_token) {
      const accessToken = tokenData.access_token;
      console.log('✅ Access token found in root object');
      return accessToken;
    }

    console.warn('⚠️ No access token found in response');
    return '';
  } catch (error) {
    console.error('❌ Error fetching access token:', error);
    return '';
  }
}

export function defaultMcpServers(accessToken: any): MCPServerConfig[] {
  console.log(`Access token got${accessToken}`);
  return [
    /*
    {
      name: 'todo-mcp-server',
      command: '/usr/bin/node',
      args: ['dist/mcp-server/todo-mcp-server.js'],
      env: {
        ACCESS_TOKEN: accessToken,
      },
    },*/
     {
      name: 'HITLProcy_todo-mcp-server',
      command: '/usr/bin/node',
      args: ['dist/mcp-server/HITLProxy.js','todo-mcp-server'],
      env: {
        ACCESS_TOKEN: accessToken,
      }
    },
  ];
}
