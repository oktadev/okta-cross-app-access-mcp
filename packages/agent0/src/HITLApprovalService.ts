import axios, { AxiosInstance } from 'axios';
import https from 'https';

function throwExpression(message: string): never {
    throw new Error(message);
}

/**
 * Service class to manage Okta Out-of-Band (OOB) authentication flow
 * for approval requests.
 */
export class HITLApprovalService {
    // Okta base URL for the authorization server
    private readonly baseUrl: string = 'https://sohailpathan.oktapreview.com/oauth2/v1';

    // Configuration properties
    private readonly clientId: string;
    private readonly clientSecret: string;
    private readonly httpClient: AxiosInstance;

    /**
     * Initializes the OktaApprovalService.
     * @param clientId - The client ID of your Okta application.
     * @param clientSecret - The client secret of your Okta application.
     */
    constructor(clientId?: string, clientSecret?: string) {
        this.clientId = clientId ?? process.env.HITLAPPROVALCLIENTID ?? throwExpression("Client Id Required");
        this.clientSecret = clientSecret ?? process.env.HITLAPPROVALCLIENTSECRET ?? throwExpression("Client Secret Required");;

        // Initialize axios instance for consistent headers/base URL
        // For development/container environments, we may need to handle SSL certificate verification
        const httpsAgent = new https.Agent({
            // In production, you should set this to true and ensure proper certificates
            // For dev containers or environments with certificate issues, this can be set to false
            rejectUnauthorized: process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0'
        });

        this.httpClient = axios.create({
            baseURL: this.baseUrl,
            timeout: 30000, // 30 second timeout
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            httpsAgent: httpsAgent,
        });

        console.log(`🔧 HITLApprovalService initialized - baseUrl: ${this.baseUrl}`);
    }
    //------------------------------------------------------------------

    /**
     * Test network connectivity to Okta server
     * @returns Promise resolving to true if connection is successful
     */
    public async testConnectivity(): Promise<boolean> {
        try {
            console.log('🔍 Testing connectivity to Okta server...');
            const response = await this.httpClient.get('/.well-known/openid-configuration', {
                timeout: 10000 // 10 second timeout for test
            });
            console.log('✅ Connectivity test successful!', {
                status: response.status,
                issuer: response.data.issuer
            });
            return true;
        } catch (error) {
            console.error('❌ Connectivity test failed:', {
                message: error instanceof Error ? error.message : 'Unknown error',
                code: axios.isAxiosError(error) ? error.code : undefined,
                baseUrl: this.baseUrl
            });
            return false;
        }
    }
    //------------------------------------------------------------------

    /**
     * 1. Sends an OOB request to the user (e.g., via Okta Verify Push).
     * This corresponds to the first CURL command (`oob-authenticate`).
     * * @param username - The user's login hint (e.g., 'username@username.com').
     * @returns A Promise resolving to the OOB code needed for polling.
     * @throws An error if the request fails or the OOB code is missing.
     */
    public async sendApprovalRequest(username: string): Promise<string> {
        const endpoint = '/oob-authenticate';

        console.log(`🔔 Sending approval request to ${username} via ${this.baseUrl}${endpoint}`);

        // Prepare the request body as URL-encoded data
        const data = new URLSearchParams();
        data.append('client_id', this.clientId);
        data.append('login_hint', username);
        data.append('channel_hint', 'push');
        data.append('client_secret', this.clientSecret);

        try {
            const response = await this.httpClient.post(endpoint, data.toString());

            // The response for oob-authenticate should contain the oob_code
            const oobCode = response.data.oob_code;

            if (!oobCode) {
                throw new Error("OOB code not received from Okta.");
            }

            console.log(`✅ Approval request sent for ${username}. OOB Code received.`);
            return oobCode;
        } catch (error) {
            if (axios.isAxiosError(error)) {
                console.error('❌ Failed to send approval request:', {
                    message: error.message,
                    code: error.code,
                    status: error.response?.status,
                    data: error.response?.data,
                });
            } else {
                console.error('❌ Failed to send approval request:', error);
            }
            // Re-throw or handle the error as appropriate for your application
            throw new Error(`Okta Approval Request failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    //------------------------------------------------------------------

    /**
     * 2. Checks for approval by polling the token endpoint using the OOB code.
     * This corresponds to the second CURL command (`token`).
     * * @param oobCode - The OOB code received from the `sendApprovalRequest` method.
     * @returns A Promise resolving to the full Token Response (e.g., access_token, id_token).
     * @throws An error if the request fails (e.g., approval rejected, timeout, or network error).
     */
    public async checkForApproval(oobCode: string): Promise<any> {
        const endpoint = '/token';

        // Prepare the request body as URL-encoded data
        const data = new URLSearchParams();
        data.append('grant_type', 'urn:okta:params:oauth:grant-type:oob');
        data.append('scope', 'openid profile'); // Use the scopes required by your application
        data.append('client_id', this.clientId);
        data.append('oob_code', oobCode);
        data.append('client_secret', this.clientSecret);

        try {
            const response = await this.httpClient.post(endpoint, data.toString());

           return "APPROVED"
        } catch (error) {
           if (axios.isAxiosError(error) && error.response) {
            const errorData = error.response.data;

            // 🎯 CRITICAL CHANGE: Check for 'authorization_pending' error code
            if (errorData.error === 'authorization_pending') {
                return "PENDING"; // Approval is still pending, return the status
            }

            // For all other errors (access_denied, expired, invalid_grant, etc.),
            // throw the error data to be treated as a definitive failure by the caller.
            errorData.httpStatus = error.response.status;
            throw errorData;
        }

        // Re-throw if it's a non-Axios (network) error
        console.error('❌ Network error during approval check:', error);
        throw new Error('HITL Approval Check failed due to network error.');
        }
    }
}
