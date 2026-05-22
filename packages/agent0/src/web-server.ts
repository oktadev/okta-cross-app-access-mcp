import RedisStore from 'connect-redis';
import cors from 'cors';
import express, { RequestHandler } from 'express';
import { createServer } from 'http';
import morgan from 'morgan';
import path from 'path';
import { createClient } from 'redis';
import { Server } from 'socket.io';

import dotenv from 'dotenv';
import session from 'express-session';
import findConfig from 'find-config';
import passport from 'passport';
import { BEDROCK_MODELS, DEFAULT_MODEL } from './config.js';
import { logger } from './logger.js';
import { MCPBedrockClient } from './mcp-bedrock-client.js';
import prisma from './prisma.js';
import article from './server/controllers/article.js';
import authtoken from './server/controllers/authtoken.js';
import oidc, { AGENT_COOKIE_NAME } from './server/controllers/oidc.js';
import user from './server/controllers/user.js';
import { JWT_STRATEGY_NAME, jwtStrategy } from './server/jwt/jwt-strategy.js';
import { defaultMcpServers, getAccessToken } from './utils.js';

declare module 'express-session' {
  interface SessionData {
    authState?: {
      isAuthenticated: boolean;
      authToken?: string;
      authTimestamp?: number;
      userInfo?: any;
    };
    bedrockState?: {
      isInitialized: boolean;
      region?: string;
      modelId?: string;
      initTimestamp?: number;
    };
    clientId?: string;
  }
}

const authenticated: RequestHandler = (req, res, next) => {
  if (req.isUnauthenticated()) {
    passport.authenticate(JWT_STRATEGY_NAME, {
      session: false,
      passReqToCallback: true,
      failWithError: false,
    })(req, res, next);
    return;
  }

  next();
};

interface ConnectedClient {
  id: string;
  mcpClient: MCPBedrockClient;
  connectedServers: string[];
  sessionId?: string;
  authState?: {
    isAuthenticated: boolean;
    authToken?: string;
    authTimestamp?: number;
    userInfo?: any;
  };
  bedrockState?: {
    isInitialized: boolean;
    region?: string;
    modelId?: string;
    initTimestamp?: number;
  };
}

dotenv.config({ path: findConfig('.env') || undefined });

// Create shared session middleware
const redisClient = createClient({
  url: process.env.REDIS_SERVER,
});

redisClient.connect().catch(console.error);

const redisStore = new RedisStore({
  client: redisClient,
  prefix: 'agent0:',
});

const cookieSecret = process.env.COOKIE_SECRET;
if (!cookieSecret) {
  throw new Error('Missing env variable COOKIE_SECRET');
}

const sessionMiddleware = session({
  resave: false,
  saveUninitialized: false,
  secret: cookieSecret,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
  },
  name: AGENT_COOKIE_NAME,
  store: redisStore,
});

class MCPWebServer {
  // Find the nearest .env and load it into process.ENV

  private app: express.Application;

  private server: any;

  private io: Server;

  private connectedClients: Map<string, ConnectedClient> = new Map();

  private port: number;

  private accessToken: any;

  constructor(port: number = 3000) {
    this.port = port;
    this.app = express();
    // this.app.set('trust proxy', 1); // Trust Codespaces/Heroku-style proxy
    this.server = createServer(this.app);
    this.io = new Server(this.server, {
      cors: {
        origin: '*',
        methods: ['GET', 'POST'],
      },
    });

    // Share session between Express and Socket.io
    this.io.use((socket, next) => {
      sessionMiddleware(socket.request as any, {} as any, (err: any) => {
        if (err) {
          next(new Error(err));
        } else {
          next();
        }
      });
    });

    this.setupMiddleware();
    this.setupRoutes();
    this.setupSocketHandlers();
  }

  private setupMiddleware(): void {
    // Security middleware
    // this.app.use(helmet({
    //   contentSecurityPolicy: {
    //     directives: {
    //       defaultSrc: ["'self'"],
    //       scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.socket.io"],
    //       styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
    //       fontSrc: ["'self'", "https://fonts.gstatic.com"],
    //       connectSrc: ["'self'", "ws:", "wss:"],
    //     },
    //   },
    // }));

    this.app.use(express.json());

    // CORS
    this.app.use(cors());

    // Logging
    this.app.use(morgan('combined'));

    // Body parsing
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));

    // Static files
    this.app.use(express.static(path.join(process.cwd(), 'public')));

    this.app.locals.redisClient = redisClient;

    // Use shared session middleware
    this.app.use(sessionMiddleware as any);

    this.app.use(passport.initialize() as any);
    this.app.use(passport.session());
    passport.serializeUser(async (dbUser: any, done) => {
      done(null, dbUser.id);
    });

    passport.deserializeUser(async (id: number, done) => {
      const dbUser = await prisma.user.findUnique({
        where: {
          id,
        },
      });

      done(null, dbUser);
    });

    passport.use(JWT_STRATEGY_NAME, jwtStrategy);

    // Enable trust proxy for Codespaces
    // this.app.set('trust proxy', 1);

    // Override host and protocol for Codespaces
    // this.app.use((req, res, next) => {
    //   if (process.env.CODESPACE_NAME) {
    //     req.headers['host'] = `${process.env.CODESPACE_NAME}-3000.app.github.dev`;
    //     req.headers['x-forwarded-proto'] = 'https';
    //   }
    //   next();
    // });
  }

  private setupRoutes(): void {
    // Health check
    this.app.get('/health', (req, res) => {
      res.json({ status: 'ok', timestamp: new Date().toISOString() });
    });

    // API routes
    this.app.get('/api/servers', (req, res) => {
      const cookies = req.headers.cookie;
      getAccessToken(cookies).then((token) => {
        res.json(defaultMcpServers(token));
        console.log('Non-async function finished');
      });
    });

    this.app.get('/api/models', (req, res) => {
      res.json(Object.values(BEDROCK_MODELS));
    });

    // Session management endpoints
    this.app.get('/api/session/status', (req, res) => {
      const sessionId = req.sessionID;
      const authState = req.session?.authState || { isAuthenticated: false };
      const bedrockState = req.session?.bedrockState || { isInitialized: false };

      console.log('Session status requested:', {
        sessionId,
        authState,
        bedrockState,
        clientId: req.session?.clientId,
      });

      res.json({
        sessionId,
        authState,
        bedrockState,
        clientId: req.session?.clientId,
      });
    });

    this.app.post('/api/session/bedrock/save', (req, res) => {
      const { region, modelId, isInitialized } = req.body;

      if (!req.session) {
        return res.status(500).json({ error: 'Session not available' });
      }

      req.session.bedrockState = {
        isInitialized: !!isInitialized,
        region,
        modelId,
        initTimestamp: Date.now(),
      };

      res.json({ success: true, message: 'Bedrock state saved to session' });
    });

    this.app.post('/api/session/auth/save', (req, res) => {
      const { isAuthenticated, authToken, userInfo } = req.body;

      if (!req.session) {
        return res.status(500).json({ error: 'Session not available' });
      }

      req.session.authState = {
        isAuthenticated: !!isAuthenticated,
        authToken,
        authTimestamp: Date.now(),
        userInfo,
      };

      res.json({ success: true, message: 'Authentication state saved to session' });
    });

    this.app.post('/api/session/clear', (req, res) => {
      if (req.session) {
        req.session.authState = { isAuthenticated: false };
        req.session.bedrockState = { isInitialized: false };
        req.session.clientId = undefined;
      }

      res.json({ success: true, message: 'Session cleared' });
    });

    // Serve the main page
    this.app.get('/', (req, res) => {
      res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
    });

    this.app.use('/api/articles', authenticated, article);
    this.app.use('/api/users', authenticated, user);
    this.app.use('/api/tokens', authenticated, authtoken);
    this.app.use('/api/free/tokens', authtoken);
    this.app.use('/api/openid/', oidc);
  }

  private setupSocketHandlers(): void {
    this.io.on('connection', (socket) => {
      logger.info(`Client connected: ${socket.id}`);

      // Initialize client
      socket.on('initialize', async (config) => {
        try {
          const mcpClient = new MCPBedrockClient({
            region: config.region || process.env.AWS_REGION || 'us-east-1',
            modelId: config.modelId || process.env.BEDROCK_MODEL_ID || DEFAULT_MODEL,
          });

          // Test AWS connection
          await mcpClient.sendMessage(
            'Hello, this is a test message to verify AWS Bedrock connectivity.',
          );
          mcpClient.clearHistory();

          // Get session from socket request
          const req = socket.request as any;
          const sessionId = req.sessionID;
          const { session } = req;

          // Update session with Bedrock state
          if (session) {
            session.bedrockState = {
              isInitialized: true,
              region: config.region || process.env.AWS_REGION || 'us-east-1',
              modelId: config.modelId || process.env.BEDROCK_MODEL_ID || DEFAULT_MODEL,
              initTimestamp: Date.now(),
            };
            session.clientId = socket.id;

            // Save session
            session.save((err: any) => {
              if (err) {
                logger.error('Session save error:', err);
              }
            });
          }

          this.connectedClients.set(socket.id, {
            id: socket.id,
            mcpClient,
            connectedServers: [],
            sessionId,
            authState: session?.authState || { isAuthenticated: false },
            bedrockState: {
              isInitialized: true,
              region: config.region || process.env.AWS_REGION || 'us-east-1',
              modelId: config.modelId || process.env.BEDROCK_MODEL_ID || DEFAULT_MODEL,
              initTimestamp: Date.now(),
            },
          });

          socket.emit('initialized', {
            success: true,
            sessionId,
            bedrockState: session?.bedrockState,
            authState: session?.authState || { isAuthenticated: false },
          });
          logger.success(`Client ${socket.id} initialized successfully`);
        } catch (error) {
          logger.error(`Failed to initialize client ${socket.id}`, error);
          socket.emit('initialized', {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      });

      // Connect to MCP server
      socket.on('connect_server', async (serverConfig) => {
        // todo: Invoke Auth Flow
        const clientData = this.connectedClients.get(socket.id);
        if (!clientData) {
          socket.emit('server_connection_result', {
            success: false,
            error: 'Client not initialized',
          });
          return;
        }

        try {
          // Skip token fetching for reminder server as it doesn't use tokens
          console.log(`⏳ Connecting to MCP server: ${serverConfig.name}`);

          await clientData.mcpClient.connectToMCPServer(serverConfig);
          clientData.connectedServers.push(serverConfig.name);

          // Get available tools
          const tools = await clientData.mcpClient.listAllTools();

          socket.emit('server_connection_result', {
            success: true,
            serverName: serverConfig.name,
            tools: tools[serverConfig.name] || [],
          });

          logger.success(`Client ${socket.id} connected to server: ${serverConfig.name}`);
        } catch (error) {
          logger.error(
            `Failed to connect client ${socket.id} to server ${serverConfig.name}`,
            error,
          );
          socket.emit('server_connection_result', {
            success: false,
            serverName: serverConfig.name,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      });

      // Send message
      socket.on('send_message', async (message) => {
        const clientData = this.connectedClients.get(socket.id);
        if (!clientData) {
          console.error(`Client data not found for socket ${socket.id}`);
          socket.emit('message_response', {
            success: false,
            error: 'Client not initialized',
          });
          return;
        }

        try {
          console.log(`Processing message for client ${socket.id}: "${message}"`);
          socket.emit('message_status', { status: 'thinking' });

          const response = await clientData.mcpClient.sendMessage(message);

          console.log(`Message response for client ${socket.id}:`, response);

          socket.emit('message_response', {
            success: true,
            response,
            history: clientData.mcpClient.getHistory(),
          });

          logger.info(`Message processed for client ${socket.id}`);
        } catch (error) {
          console.error(`Failed to process message for client ${socket.id}:`, error);
          logger.error(`Failed to process message for client ${socket.id}`, error);
          socket.emit('message_response', {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      });

      // Get tools
      socket.on('get_tools', async () => {
        const clientData = this.connectedClients.get(socket.id);
        if (!clientData) {
          socket.emit('tools_list', { success: false, error: 'Client not initialized' });
          return;
        }

        try {
          const tools = await clientData.mcpClient.listAllTools();
          socket.emit('tools_list', { success: true, tools });
        } catch (error) {
          logger.error(`Failed to get tools for client ${socket.id}`, error);
          socket.emit('tools_list', {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      });

      // Get conversation history
      socket.on('get_history', () => {
        const clientData = this.connectedClients.get(socket.id);
        if (!clientData) {
          socket.emit('history', { success: false, error: 'Client not initialized' });
          return;
        }

        const history = clientData.mcpClient.getHistory();
        socket.emit('history', { success: true, history });
      });

      // Clear conversation history
      socket.on('clear_history', () => {
        const clientData = this.connectedClients.get(socket.id);
        if (!clientData) {
          socket.emit('history_cleared', { success: false, error: 'Client not initialized' });
          return;
        }

        clientData.mcpClient.clearHistory();
        socket.emit('history_cleared', { success: true });
      });

      // Handle authentication completion
      socket.on('auth_completed', async () => {
        const clientData = this.connectedClients.get(socket.id);
        if (!clientData) {
          socket.emit('auth_result', { success: false, error: 'Client not initialized' });
          return;
        }

        try {
          // Get session from socket request
          const req = socket.request as any;
          const { session } = req;

          // Update session with authentication state
          if (session) {
            session.authState = {
              isAuthenticated: true,
              authToken: `mock-token-${Date.now()}`,
              authTimestamp: Date.now(),
              userInfo: { username: 'authenticated-user' },
            };

            // Save session
            session.save((err: any) => {
              if (err) {
                logger.error('Session save error:', err);
              }
            });
          }

          // Update client auth state
          clientData.authState = {
            isAuthenticated: true,
            authToken: `mock-token-${Date.now()}`,
            authTimestamp: Date.now(),
            userInfo: { username: 'authenticated-user' },
          };

          socket.emit('auth_result', {
            success: true,
            authState: clientData.authState,
          });
          logger.success(`Authentication completed for client ${socket.id}`);
        } catch (error) {
          logger.error(`Authentication failed for client ${socket.id}`, error);
          socket.emit('auth_result', {
            success: false,
            error: error instanceof Error ? error.message : 'Authentication failed',
          });
        }
      });

      // Check session status
      socket.on('check_session', () => {
        const clientData = this.connectedClients.get(socket.id);
        const req = socket.request as any;

        const sessionData = {
          authState: req.session?.authState || { isAuthenticated: false },
          bedrockState: req.session?.bedrockState || { isInitialized: false },
          sessionId: req.sessionID,
        };

        console.log('Socket session check:', {
          socketId: socket.id,
          sessionData,
          hasClientData: !!clientData,
        });

        // Update client data with session info
        if (clientData) {
          clientData.authState = sessionData.authState;
          clientData.bedrockState = sessionData.bedrockState;
        }

        socket.emit('session_status', {
          success: true,
          ...sessionData,
        });
      });

      // Handle logout
      socket.on('logout', () => {
        const clientData = this.connectedClients.get(socket.id);
        const req = socket.request as any;

        if (req.session) {
          req.session.authState = {
            isAuthenticated: false,
            authToken: undefined,
            authTimestamp: undefined,
            userInfo: undefined,
          };

          req.session.save((err: any) => {
            if (err) {
              logger.error('Session save error during logout:', err);
            }
          });
        }

        if (clientData) {
          clientData.authState = { isAuthenticated: false };
        }

        socket.emit('logout_result', { success: true });
        logger.info(`User logged out for client ${socket.id}`);
      });

      // Restore existing session
      socket.on('restore_session', async () => {
        try {
          const req = socket.request as any;
          const { session } = req;
          const sessionId = req.sessionID;

          if (!session?.bedrockState?.isInitialized) {
            socket.emit('session_restored', {
              success: false,
              error: 'No existing Bedrock session found',
            });
            return;
          }

          // Create new MCP client with existing session config
          const mcpClient = new MCPBedrockClient({
            region: session.bedrockState.region || process.env.AWS_REGION || 'us-east-1',
            modelId: session.bedrockState.modelId || process.env.BEDROCK_MODEL_ID || DEFAULT_MODEL,
          });

          // Test the connection
          await mcpClient.sendMessage('Session restoration test');
          mcpClient.clearHistory();

          // Update client mapping
          this.connectedClients.set(socket.id, {
            id: socket.id,
            mcpClient,
            connectedServers: [],
            sessionId,
            authState: session?.authState || { isAuthenticated: false },
            bedrockState: session.bedrockState,
          });

          // Update session with new client ID
          session.clientId = socket.id;
          session.save((err: any) => {
            if (err) {
              logger.error('Session save error during restoration:', err);
            }
          });

          socket.emit('session_restored', {
            success: true,
            sessionId,
            bedrockState: session.bedrockState,
            authState: session?.authState || { isAuthenticated: false },
          });

          logger.success(`Session restored for client ${socket.id}`);
        } catch (error) {
          logger.error(`Failed to restore session for client ${socket.id}`, error);
          socket.emit('session_restored', {
            success: false,
            error: error instanceof Error ? error.message : 'Session restoration failed',
          });
        }
      });

      // Handle disconnect
      socket.on('disconnect', async () => {
        const clientData = this.connectedClients.get(socket.id);
        if (clientData) {
          try {
            await clientData.mcpClient.disconnect();
          } catch (error) {
            logger.error(`Error disconnecting client ${socket.id}`, error);
          }
          this.connectedClients.delete(socket.id);
        }
        logger.info(`Client disconnected: ${socket.id}`);
      });
    });
  }

  /**
   * Initiates authentication flow after Bedrock connection is established
   */
  private async initiate_auth(): Promise<void> {
    try {
      logger.info('🔐 Initiating authentication flow...');
      const authServer = process.env.AUTH_SERVER;
      const baseUrl = process.env.APP_BASE_URL || `http://localhost:3000`;
      const redirectUri = encodeURIComponent(`${baseUrl}/api/openid/callback/`);
      const authUrl = `${authServer}/auth?response_type=code&client_id=agent0&redirect_uri=${redirectUri}&scope=openid%20profile%20email%20openid%20read%20write&login_hint=bob%40tables.fake&state=YmlpYLq2bBsDMoLYRf7Bvx2s`;

      // Make the authentication request
      const response = await fetch(authUrl, {
        method: 'GET',
        headers: {
          Accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
          'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8',
          'Cache-Control': 'no-cache',
          'User-Agent': 'Mozilla/5.0 (compatible; MCP-Client/1.0)',
        },
        redirect: 'manual',
      });

      const responseText = await response.text();
      const location = response.headers.get('location');

      logger.info(`Authentication request completed:`);
      logger.info(`- Status: ${response.status} ${response.statusText}`);
      if (location) {
        logger.info(`- Redirect: ${location}`);
      }

      // Check if authentication was successful
      if (response.status === 302 || response.status === 200) {
        logger.success('✅ Authentication flow initiated successfully');
      } else {
        logger.warn('⚠️ Authentication flow may have issues');
      }
    } catch (error) {
      logger.error('❌ Failed to initiate authentication flow', error);
    }
  }

  public async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(this.port, '0.0.0.0', () => {
        logger.success(`Agent0 MCP Web Server running on http://localhost:${this.port}`);
        resolve();
      });
    });
  }

  public async stop(): Promise<void> {
    return new Promise((resolve) => {
      // Disconnect all clients
      for (const [socketId, clientData] of this.connectedClients) {
        try {
          clientData.mcpClient.disconnect();
        } catch (error) {
          logger.error(`Error disconnecting client ${socketId}`, error);
        }
      }
      this.connectedClients.clear();

      this.server.close(() => {
        logger.info('Agent0 MCP Web Server stopped');
        resolve();
      });
    });
  }
}

export { MCPWebServer };
