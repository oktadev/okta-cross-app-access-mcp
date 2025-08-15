class MCPClient {
    constructor() {
        this.socket = null;
        this.isInitialized = false;
        this.connectedServers = new Map(); // Change to Map to track more details
        this.availableServers = [];
        this.sessionId = null;
        this.authState = { isAuthenticated: false };
        this.bedrockState = { isInitialized: false };
        this.serverConnectionStates = new Map(); // Track connection states

        // Restore pre-auth state if available
        this.restorePreAuthState();

        this.initializeElements();
        this.attachEventListeners();
        this.loadAvailableServers();
        this.checkSessionStatus();
    }

    restorePreAuthState() {
        try {
            const preAuthState = sessionStorage.getItem('preAuthState');
            if (preAuthState) {
                const state = JSON.parse(preAuthState);
                // Only restore if it's recent (within last 5 minutes)
                if (Date.now() - state.timestamp < 300000) {
                    this.isInitialized = state.isInitialized;
                    this.sessionId = state.sessionId;
                }
                // Clear the stored state
                sessionStorage.removeItem('preAuthState');
            }
        } catch (error) {
            console.error('Failed to restore pre-auth state:', error);
        }
    }

    initializeElements() {
        // Status elements
        this.statusDot = document.getElementById('connectionStatus');
        this.statusText = document.getElementById('statusText');

        // Form elements
        this.regionSelect = document.getElementById('region');
        this.modelSelect = document.getElementById('modelId');
        this.initializeBtn = document.getElementById('initializeBtn');
        this.connectIdpBtn = document.getElementById('connectIdpBtn');

        // Chat elements
        this.messages = document.getElementById('messages');
        this.messageInput = document.getElementById('messageInput');
        this.sendBtn = document.getElementById('sendBtn');
        this.typingIndicator = document.getElementById('typingIndicator');

        // Sidebar elements
        this.sidebar = document.getElementById('sidebar');
        this.collapseSidebar = document.getElementById('collapseSidebar');
        this.serversList = document.getElementById('serversList');
        this.toolsList = document.getElementById('toolsList');

        // Button elements
        this.refreshServers = document.getElementById('refreshServers');
        this.getToolsBtn = document.getElementById('getTools');
        this.clearHistoryBtn = document.getElementById('clearHistory');
        this.getHistory = document.getElementById('getHistory');

        // Modal elements
        this.historyModal = document.getElementById('historyModal');
        this.closeHistoryModal = document.getElementById('closeHistoryModal');
        this.historyContent = document.getElementById('historyContent');
    }

    attachEventListeners() {
        // Socket connection
        this.initializeBtn.addEventListener('click', () => this.initializeConnection());
        this.connectIdpBtn.addEventListener('click', () => this.connectToIDP());

        // Chat functionality
        this.sendBtn.addEventListener('click', () => this.sendMessage());
        this.messageInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.sendMessage();
            }
        });

        // Auto-resize textarea
        this.messageInput.addEventListener('input', () => this.autoResizeTextarea());

        // Sidebar functionality
        this.collapseSidebar.addEventListener('click', () => this.toggleSidebar());
        this.refreshServers.addEventListener('click', () => this.loadAvailableServers());
        this.getToolsBtn.addEventListener('click', () => this.getTools());
        this.clearHistoryBtn.addEventListener('click', () => this.clearHistory());
        this.getHistory.addEventListener('click', () => this.showHistory());

        // Modal functionality
        this.closeHistoryModal.addEventListener('click', () => this.hideHistory());
        this.historyModal.addEventListener('click', (e) => {
            if (e.target === this.historyModal) this.hideHistory();
        });

        // Escape key to close modal
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.historyModal.classList.contains('show')) {
                this.hideHistory();
            }
        });
    }

    async checkSessionStatus() {
        try {
            // Check if we're returning from authentication
            const urlParams = new URLSearchParams(window.location.search);
            const authStatus = urlParams.get('auth');

            // Always check session status from server first
            const response = await fetch('/api/session/status');
            const sessionData = await response.json();

            this.sessionId = sessionData.sessionId;
            this.authState = sessionData.authState || { isAuthenticated: false };
            this.bedrockState = sessionData.bedrockState || { isInitialized: false };

            console.log('Session status:', sessionData);

            if (authStatus === 'success') {
                // Clear the URL parameter
                window.history.replaceState({}, document.title, window.location.pathname);
                this.addMessage('system', 'Authentication completed successfully! Welcome back.');

                // Force update UI
                this.updateAuthUI();
                this.updateBedrockUI();

            } else if (authStatus === 'error') {
                window.history.replaceState({}, document.title, window.location.pathname);
                this.addMessage('error', 'Authentication failed. Please try again.');
            } else {
                // Update UI based on current session state
                this.updateAuthUI();
                this.updateBedrockUI();

                if (this.bedrockState.isInitialized) {
                    this.addMessage('system', 'Existing Bedrock session found - restoring connection...');
                    // Don't auto-connect socket here, let user click reconnect
                }

                if (this.authState.isAuthenticated) {
                    this.addMessage('system', 'Existing authentication session found - already authenticated');
                }
            }

            // Connect socket for future use (but don't auto-initialize Bedrock)
            this.connectSocket();

        } catch (error) {
            console.error('Failed to check session status:', error);
            // Fall back to connecting socket anyway
            this.connectSocket();
        }
    }

    connectSocket() {
        if (this.socket && this.socket.connected) {
            return; // Already connected
        }

        if (this.socket) {
            this.socket.disconnect();
        }

        this.socket = io();
        this.setupSocketHandlers();

        // When socket connects, check if we can restore an existing session
        this.socket.on('connect', () => {
            console.log('Socket connected');
            this.socket.emit('check_session');

            // If we have an existing Bedrock session, try to restore it
            if (this.bedrockState.isInitialized) {
                console.log('Attempting to restore existing Bedrock session...');
                this.socket.emit('restore_session');
            }
        });
    }

    connectSocketAndRestore() {
        this.connectSocket();

        // Wait for socket to connect, then restore session
        this.socket.on('connect', () => {
            setTimeout(() => {
                this.restoreBedrockSession();
            }, 100);
        });
    }

    restoreBedrockSession() {
        if (!this.bedrockState.isInitialized) {
            return;
        }

        // Restore the existing session by emitting a check_session first
        this.socket.emit('check_session');

        // Set UI state based on existing session
        this.isInitialized = true;
        this.messageInput.disabled = false;
        this.sendBtn.disabled = false;
        this.connectIdpBtn.disabled = false;
        this.initializeBtn.textContent = 'Reconnect';
        this.updateStatus('connected', 'Connected');
        this.addMessage('system', 'Bedrock session restored successfully!');
    }

    setupSocketHandlers() {
        this.socket.on('connect', () => {
            console.log('Socket connected in setupSocketHandlers');
            // Always check session status when socket connects
            this.socket.emit('check_session');
        });

        this.socket.on('initialized', (response) => {
            if (response.success) {
                this.updateStatus('connected', 'Connected');
                this.isInitialized = true;
                this.messageInput.disabled = false;
                this.sendBtn.disabled = false;
                this.connectIdpBtn.disabled = false;
                this.initializeBtn.textContent = 'Reconnect';
                this.addMessage('system', '✅ Successfully connected to AWS Bedrock! You can now start chatting.');
                this.clearWelcomeMessage();

                // Update session data
                if (response.sessionId) {
                    this.sessionId = response.sessionId;
                }
                if (response.bedrockState) {
                    this.bedrockState = response.bedrockState;
                }
                if (response.authState) {
                    this.authState = response.authState;
                    this.updateAuthUI();
                }

                // Save Bedrock state to session
                this.saveBedrockState({
                    region: this.regionSelect.value,
                    modelId: this.modelSelect.value
                });

                // Auto-connect to available MCP servers
                this.autoConnectToServers();
            } else {
                this.updateStatus('disconnected', 'Connection Failed');
                this.addMessage('error', `Failed to initialize: ${response.error}`);
            }
            this.initializeBtn.disabled = false;
        });

        this.socket.on('server_connection_result', (response) => {
            if (response.success) {
                this.connectedServers.set(response.serverName, {
                    name: response.serverName,
                    connected: true,
                    connectedAt: new Date(),
                    tools: response.tools || []
                });
                this.serverConnectionStates.set(response.serverName, 'connected');
                this.addMessage('system', `✅ Connected to MCP server: ${response.serverName}`);
                this.updateServerStatus(response.serverName, 'connected');
                this.updateServerConnectionCount();
                if (response.tools && response.tools.length > 0) {
                    this.addMessage('system', `🔧 Found ${response.tools.length} tools in ${response.serverName}`);
                }
            } else {
                this.serverConnectionStates.set(response.serverName, 'disconnected');
                this.addMessage('error', `❌ Failed to connect to ${response.serverName}: ${response.error}`);
                this.updateServerStatus(response.serverName, 'disconnected');
                this.updateServerConnectionCount();
            }
        });

        this.socket.on('message_status', (status) => {
            if (status.status === 'thinking') {
                this.showTypingIndicator();
            }
        });

        this.socket.on('message_response', (response) => {
            this.hideTypingIndicator();
            if (response.success) {
                this.addMessage('assistant', response.response);
            } else {
                this.addMessage('error', `Error: ${response.error}`);
            }
            this.messageInput.disabled = false;
            this.sendBtn.disabled = false;
        });

        this.socket.on('tools_list', (response) => {
            if (response.success) {
                this.displayTools(response.tools);
            } else {
                this.addMessage('error', `Failed to get tools: ${response.error}`);
            }
        });

        this.socket.on('history', (response) => {
            if (response.success) {
                this.displayHistory(response.history);
            }
        });

        this.socket.on('history_cleared', (response) => {
            if (response.success) {
                this.addMessage('system', 'Conversation history cleared');
            }
        });

        this.socket.on('auth_result', (response) => {
            if (response.success) {
                this.authState = response.authState || { isAuthenticated: true };
                this.updateAuthUI();
                this.addMessage('system', 'Authentication completed successfully!');

                // Save auth state to session
                if (response.authState) {
                    this.saveAuthState(response.authState);
                }
            } else {
                this.addMessage('error', `Authentication failed: ${response.error}`);
            }
        });

        this.socket.on('session_status', (response) => {
            if (response.success) {
                console.log('Session status received:', response);
                this.sessionId = response.sessionId;
                this.authState = response.authState || { isAuthenticated: false };
                this.bedrockState = response.bedrockState || { isInitialized: false };

                // Update UI based on session state
                this.updateAuthUI();
                this.updateBedrockUI();
            }
        });

        this.socket.on('logout_result', (response) => {
            if (response.success) {
                this.authState = { isAuthenticated: false };
                this.updateAuthUI();
                this.addMessage('system', 'Logged out successfully');
            }
        });

        this.socket.on('disconnect', () => {
            console.log('Socket disconnected');
            this.updateStatus('disconnected', 'Disconnected');
            // Mark all servers as disconnected
            this.connectedServers.forEach((server, name) => {
                this.serverConnectionStates.set(name, 'disconnected');
                this.updateServerStatus(name, 'disconnected');
            });
            this.connectedServers.clear();
            this.updateServerConnectionCount();
        });

        this.socket.on('session_restored', (response) => {
            if (response.success) {
                this.updateStatus('connected', 'Connected');
                this.isInitialized = true;
                this.messageInput.disabled = false;
                this.sendBtn.disabled = false;
                this.connectIdpBtn.disabled = false;
                this.initializeBtn.textContent = 'Reconnect';
                this.addMessage('system', '✅ Bedrock session restored successfully!');
                this.clearWelcomeMessage();

                // Update session data
                if (response.sessionId) {
                    this.sessionId = response.sessionId;
                }
                if (response.bedrockState) {
                    this.bedrockState = response.bedrockState;
                }
                if (response.authState) {
                    this.authState = response.authState;
                    this.updateAuthUI();
                }

                // Auto-connect to available MCP servers after session restore
                this.autoConnectToServers();
            } else {
                console.log('Session restoration failed:', response.error);
                // Fall back to normal initialization process
                this.updateStatus('disconnected', 'Not Connected');
            }
        });
    }

    updateAuthUI() {
        console.log('Updating auth UI with state:', this.authState);

        if (this.authState.isAuthenticated) {
            this.connectIdpBtn.textContent = 'Authenticated ✓';
            this.connectIdpBtn.disabled = true;
            this.connectIdpBtn.style.backgroundColor = '#10b981';
            this.connectIdpBtn.style.color = 'white';
        } else {
            this.connectIdpBtn.textContent = 'Connect to IDP';
            this.connectIdpBtn.disabled = !this.isInitialized;
            this.connectIdpBtn.style.backgroundColor = '';
            this.connectIdpBtn.style.color = '';
        }
    }

    updateBedrockUI() {
        if (this.bedrockState.isInitialized) {
            this.isInitialized = true;
            this.messageInput.disabled = false;
            this.sendBtn.disabled = false;
            this.connectIdpBtn.disabled = false;
            this.initializeBtn.textContent = 'Reconnect';
            this.updateStatus('connected', 'Connected');
        }
    }

    async saveBedrockState(config) {
        try {
            await fetch('/api/session/bedrock/save', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    region: config.region,
                    modelId: config.modelId,
                    isInitialized: true
                })
            });
        } catch (error) {
            console.error('Failed to save Bedrock state:', error);
        }
    }

    async saveAuthState(authData) {
        try {
            await fetch('/api/session/auth/save', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    isAuthenticated: true,
                    authToken: authData.authToken,
                    userInfo: authData.userInfo
                })
            });
        } catch (error) {
            console.error('Failed to save auth state:', error);
        }
    }

    initializeConnection() {
        this.updateStatus('connecting', 'Connecting...');
        this.initializeBtn.disabled = true;
        this.initializeBtn.textContent = 'Connecting...';

        // Ensure socket is connected
        this.connectSocket();

        // If socket is already connected, initialize immediately
        if (this.socket && this.socket.connected) {
            this.socket.emit('initialize', {
                region: this.regionSelect.value,
                modelId: this.modelSelect.value
            });
        } else {
            // Wait for socket to connect, then initialize
            this.socket.once('connect', () => {
                console.log('Socket connected, initializing Bedrock...');
                setTimeout(() => {
                    this.socket.emit('initialize', {
                        region: this.regionSelect.value,
                        modelId: this.modelSelect.value
                    });
                }, 100);
            });
        }
    }

    sendMessage() {
        const message = this.messageInput.value.trim();
        if (!message || !this.isInitialized) return;

        this.addMessage('user', message);
        this.messageInput.value = '';
        this.autoResizeTextarea();
        this.messageInput.disabled = true;
        this.sendBtn.disabled = true;

        this.socket.emit('send_message', message);
    }

    addMessage(type, content) {
        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${type}`;

        const time = new Date().toLocaleTimeString();

        if (type === 'system') {
            messageDiv.innerHTML = `
                <div class="message-content" style="background: #374151; color: #e5e7eb; text-align: center; font-style: italic;">
                    ${content}
                    <div class="message-time">${time}</div>
                </div>
            `;
        } else if (type === 'error') {
            messageDiv.innerHTML = `
                <div class="message-content" style="background: #dc2626; color: white;">
                    ${content}
                    <div class="message-time">${time}</div>
                </div>
            `;
        } else {
            const avatar = type === 'user' ? '👤' : '🤖';
            messageDiv.innerHTML = `
                <div class="message-avatar">${avatar}</div>
                <div class="message-content">
                    ${this.formatMessage(content)}
                    <div class="message-time">${time}</div>
                </div>
            `;
        }

        this.messages.appendChild(messageDiv);
        this.messages.scrollTop = this.messages.scrollHeight;
    }

    formatMessage(content) {
        // Basic formatting for code blocks and line breaks
        return content
            .replace(/\n/g, '<br>')
            .replace(/`([^`]+)`/g, '<code style="background: #374151; padding: 2px 4px; border-radius: 3px;">$1</code>');
    }

    clearWelcomeMessage() {
        const welcomeMessage = this.messages.querySelector('.welcome-message');
        if (welcomeMessage) {
            welcomeMessage.remove();
        }
    }

    showTypingIndicator() {
        this.typingIndicator.style.display = 'flex';
    }

    hideTypingIndicator() {
        this.typingIndicator.style.display = 'none';
    }

    autoResizeTextarea() {
        this.messageInput.style.height = 'auto';
        this.messageInput.style.height = Math.min(this.messageInput.scrollHeight, 120) + 'px';
    }

    updateStatus(status, text) {
        this.statusDot.className = `status-dot ${status}`;
        this.statusText.textContent = text;
    }

    toggleSidebar() {
        document.querySelector('.app').classList.toggle('sidebar-collapsed');
        this.collapseSidebar.textContent =
            document.querySelector('.app').classList.contains('sidebar-collapsed') ? '→' : '←';
    }

    async loadAvailableServers() {
        try {
            const response = await fetch('/api/servers');
            this.availableServers = await response.json();
            this.renderServersList();
        } catch (error) {
            console.error('Failed to load servers:', error);
        }
    }

    renderServersList() {
        this.serversList.innerHTML = '';

        this.availableServers.forEach(server => {
            const serverDiv = document.createElement('div');
            serverDiv.className = 'server-item';

            const connectionState = this.serverConnectionStates.get(server.name) || 'disconnected';
            const isConnected = this.connectedServers.has(server.name);

            // Add connection indicator icon
            const statusIcon = connectionState === 'connected' ? '🟢' :
                             connectionState === 'connecting' ? '🟡' :
                             connectionState === 'disconnecting' ? '�' : '�🔴';

            const clickAction = isConnected ? 'Click to disconnect' : 'Click to connect';

            // Clean up command display - hide full path and show just the server type
            const displayCommand = this.getDisplayCommand(server);

            serverDiv.innerHTML = `
                <div class="server-info">
                    <div class="server-name">${statusIcon} ${server.name}</div>
                    <div class="server-command">${displayCommand}</div>
                    ${isConnected ? `<div class="server-tools">Tools: ${this.connectedServers.get(server.name)?.tools?.length || 0}</div>` : ''}
                </div>
                <div class="server-actions">
                    <div class="server-status ${connectionState}">${connectionState}</div>
                    <div class="server-hint">${clickAction}</div>
                </div>
            `;

            serverDiv.addEventListener('click', () => {
                if (isConnected) {
                    this.disconnectFromServer(server.name);
                } else {
                    this.connectToServer(server);
                }
            });
            this.serversList.appendChild(serverDiv);
        });

        // Add connection summary
        const summaryDiv = document.createElement('div');
        summaryDiv.className = 'server-summary';
        const connectedCount = this.connectedServers.size;
        const totalCount = this.availableServers.length;
        summaryDiv.innerHTML = `
            <div class="connection-summary">
                <span class="summary-icon">${connectedCount > 0 ? '✅' : '❌'}</span>
                <span>Connected: ${connectedCount}/${totalCount}</span>
            </div>
        `;
        this.serversList.appendChild(summaryDiv);
    }

    getDisplayCommand(server) {
        // Clean up command display to be more user-friendly
        if (server.command && server.command.includes('node')) {
            // For Node.js servers, show just the script name
            if (server.args && server.args.length > 0) {
                const scriptPath = server.args[0];
                const scriptName = scriptPath.split('/').pop().replace('.js', '');
                return `Node.js • ${scriptName}`;
            }
            return 'Node.js Server';
        }

        // For other commands, show just the base command
        if (server.command) {
            const baseCommand = server.command.split('/').pop();
            return `${baseCommand} ${(server.args || []).join(' ')}`;
        }

        return 'MCP Server';
    }

    connectToServer(server) {
        if (!this.isInitialized) {
            this.addMessage('error', 'Please initialize the client first');
            return;
        }

        if (this.connectedServers.has(server.name)) {
            this.addMessage('system', `Already connected to ${server.name}`);
            return;
        }

        this.addMessage('system', `🔄 Connecting to MCP server: ${server.name}...`);
        this.serverConnectionStates.set(server.name, 'connecting');
        this.updateServerStatus(server.name, 'connecting');
        this.renderServersList(); // Refresh to show connecting state
        this.socket.emit('connect_server', server);
    }

    disconnectFromServer(serverName) {
        if (!this.connectedServers.has(serverName)) {
            this.addMessage('system', `Server ${serverName} is not connected`);
            return;
        }

        this.addMessage('system', `🔌 Disconnecting from MCP server: ${serverName}...`);
        this.serverConnectionStates.set(serverName, 'disconnecting');
        this.updateServerStatus(serverName, 'disconnecting');
        this.connectedServers.delete(serverName);
        this.updateServerConnectionCount();

        // Emit disconnect event to server
        this.socket.emit('disconnect_server', { name: serverName });

        // Update UI after a brief delay
        setTimeout(() => {
            this.serverConnectionStates.set(serverName, 'disconnected');
            this.updateServerStatus(serverName, 'disconnected');
            this.renderServersList();
        }, 500);
    }

    updateServerStatus(serverName, status) {
        const serverItems = this.serversList.querySelectorAll('.server-item');
        serverItems.forEach(item => {
            const nameElement = item.querySelector('.server-name');
            if (nameElement && nameElement.textContent.includes(serverName)) {
                const statusElement = item.querySelector('.server-status');
                if (statusElement) {
                    statusElement.className = `server-status ${status}`;
                    statusElement.textContent = status;
                }

                // Update icon in name
                const statusIcon = status === 'connected' ? '🟢' :
                                 status === 'connecting' ? '🟡' : '🔴';
                nameElement.textContent = `${statusIcon} ${serverName}`;
            }
        });
    }

    updateServerConnectionCount() {
        // Update the main status if we have any connected servers
        const connectedCount = this.connectedServers.size;
        const totalCount = this.availableServers.length;

        if (connectedCount > 0) {
            this.updateStatus('connected', `Connected (${connectedCount}/${totalCount} servers)`);
        } else if (this.isInitialized) {
            this.updateStatus('connected', 'Connected (0 servers)');
        }

        // Re-render the servers list to update the summary
        this.renderServersList();
    }

    getTools() {
        if (!this.isInitialized) {
            this.addMessage('error', 'Please initialize the client first');
            return;
        }
        this.socket.emit('get_tools');
    }

    displayTools(tools) {
        this.toolsList.innerHTML = '';

        Object.entries(tools).forEach(([serverName, serverTools]) => {
            if (serverTools.length > 0) {
                const serverHeader = document.createElement('div');
                serverHeader.style.fontWeight = 'bold';
                serverHeader.style.marginBottom = '8px';
                serverHeader.style.color = '#ffffff';
                serverHeader.textContent = serverName;
                this.toolsList.appendChild(serverHeader);

                serverTools.forEach(tool => {
                    const toolDiv = document.createElement('div');
                    toolDiv.className = 'tool-item';
                    toolDiv.innerHTML = `
                        <div class="tool-name">${tool.name}</div>
                        <div class="tool-description">${tool.description || 'No description'}</div>
                    `;
                    this.toolsList.appendChild(toolDiv);
                });
            }
        });

        if (this.toolsList.children.length === 0) {
            this.toolsList.innerHTML = '<div style="color: #9ca3af; font-style: italic;">No tools available</div>';
        }
    }

    clearHistory() {
        if (!this.isInitialized) {
            this.addMessage('error', 'Please initialize the client first');
            return;
        }
        this.socket.emit('clear_history');
    }

    showHistory() {
        if (!this.isInitialized) {
            this.addMessage('error', 'Please initialize the client first');
            return;
        }
        this.socket.emit('get_history');
        this.historyModal.classList.add('show');
    }

    hideHistory() {
        this.historyModal.classList.remove('show');
    }

    displayHistory(history) {
        this.historyContent.innerHTML = '';

        if (history.length === 0) {
            this.historyContent.innerHTML = '<p style="color: #9ca3af; text-align: center;">No conversation history</p>';
            return;
        }

        history.forEach((message, index) => {
            const messageDiv = document.createElement('div');
            messageDiv.style.marginBottom = '16px';
            messageDiv.style.padding = '12px';
            messageDiv.style.background = message.role === 'user' ? '#3b82f6' : '#1a1a2e';
            messageDiv.style.borderRadius = '8px';
            messageDiv.style.color = '#ffffff';

            const timestamp = message.timestamp ? new Date(message.timestamp).toLocaleString() : '';

            messageDiv.innerHTML = `
                <div style="font-weight: bold; margin-bottom: 4px;">
                    ${message.role === 'user' ? '👤 You' : '🤖 Assistant'}
                    ${timestamp && `<span style="float: right; font-weight: normal; font-size: 0.8em;">${timestamp}</span>`}
                </div>
                <div>${this.formatMessage(message.content)}</div>
            `;

            this.historyContent.appendChild(messageDiv);
        });
    }

    connectToIDP() {
        if (!this.isInitialized) {
            this.addMessage('error', 'Please initialize the client first');
            return;
        }

        if (this.authState.isAuthenticated) {
            this.addMessage('system', 'Already authenticated');
            return;
        }

        this.addMessage('system', 'Initiating authentication with Identity Provider...');

        // Save current state before navigating away
        if (this.sessionId) {
            sessionStorage.setItem('preAuthState', JSON.stringify({
                isInitialized: this.isInitialized,
                sessionId: this.sessionId,
                timestamp: Date.now()
            }));
        }

        // Navigate to authentication URL in the same tab
        const authUrl = "/api/openid/start/bob@tables.fake";
        window.location.href = authUrl;
    }

    autoConnectToServers() {
        if (this.availableServers.length === 0) {
            this.addMessage('system', '🔍 No MCP servers available to connect to');
            return;
        }

        this.addMessage('system', `🔄 Auto-connecting to ${this.availableServers.length} available MCP servers...`);

        // Connect to all available servers with a small delay between connections
        this.availableServers.forEach((server, index) => {
            setTimeout(() => {
                if (!this.connectedServers.has(server.name)) {
                    this.connectToServer(server);
                }
            }, index * 1000); // 1 second delay between connections
        });
    }
}

// Initialize the client when the page loads
document.addEventListener('DOMContentLoaded', () => {
    new MCPClient();
});
