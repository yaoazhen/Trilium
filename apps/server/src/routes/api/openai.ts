import type { Request } from "express";
import { createHash, randomBytes } from "node:crypto";
import http, { type Server as HttpServer } from "node:http";

import log from "../../services/log.js";
import optionService from "../../services/options.js";
import { isElectron } from "../../services/utils.js";

const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1";
const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com/v1";
const OLLAMA_DEFAULT_BASE_URL = "http://localhost:11434";
const ANTHROPIC_VERSION_HEADER = "2023-06-01";
const OPENAI_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_OAUTH_ISSUER = "https://auth.openai.com";
const OPENAI_OAUTH_SCOPE = "openid profile email offline_access";
const OPENAI_OAUTH_PENDING_TIMEOUT_MS = 10 * 60 * 1000;
const OPENAI_OAUTH_REFRESH_LEEWAY_MS = 30 * 1000;
const OPENAI_OAUTH_CALLBACK_PORT = 1455;
const OPENAI_OAUTH_CALLBACK_PATH = "/auth/callback";
const OPENAI_OAUTH_REDIRECT_URI = `http://localhost:${OPENAI_OAUTH_CALLBACK_PORT}${OPENAI_OAUTH_CALLBACK_PATH}`;
const OPENAI_OAUTH_DEVICE_URL = `${OPENAI_OAUTH_ISSUER}/codex/device`;
const OPENAI_OAUTH_DEVICE_USERCODE_ENDPOINT = `${OPENAI_OAUTH_ISSUER}/api/accounts/deviceauth/usercode`;
const OPENAI_OAUTH_DEVICE_TOKEN_ENDPOINT = `${OPENAI_OAUTH_ISSUER}/api/accounts/deviceauth/token`;
const OPENAI_OAUTH_DEVICE_REDIRECT_URI = `${OPENAI_OAUTH_ISSUER}/deviceauth/callback`;
const OPENAI_OAUTH_DEVICE_POLLING_SAFETY_MARGIN_MS = 3000;

const OPENAI_OAUTH_MODELS = [
    "gpt-5.3-codex",
    "gpt-5.2-codex",
    "gpt-5.2",
    "gpt-5.1-codex-max",
    "gpt-5.1-codex",
    "gpt-5.1-codex-mini"
];

interface OpenAiModelListResponse {
    data?: Array<{ id?: string }>;
}

interface AnthropicModelListResponse {
    data?: Array<{ id?: string; display_name?: string }>;
}

interface OllamaModelListResponse {
    models?: Array<{
        name?: string;
        model?: string;
        details?: {
            family?: string;
            parameter_size?: string;
        };
    }>;
}

interface OpenAiOauthTokenResponse {
    access_token: string;
    refresh_token: string;
    expires_in?: number;
    id_token?: string;
}

interface OpenAiOauthDeviceCodeResponse {
    device_auth_id: string;
    user_code: string;
    interval?: string;
}

interface OpenAiOauthDeviceTokenResponse {
    authorization_code: string;
    code_verifier: string;
}

interface PendingOpenAiOauth {
    verifier: string;
    redirectUri: string;
    createdAt: number;
}

interface OpenAiJwtClaims {
    chatgpt_account_id?: string;
    email?: string;
    organizations?: Array<{ id?: string }>;
    "https://api.openai.com/auth"?: {
        chatgpt_account_id?: string;
    };
}

const pendingOpenAiOauth = new Map<string, PendingOpenAiOauth>();
let oauthCallbackServer: HttpServer | undefined;
let oauthCallbackServerStarting: Promise<void> | undefined;
let deviceAuthCancelCurrent: (() => void) | undefined;
let deviceAuthPollCurrent: Promise<void> | undefined;

function cleanupPendingOauthStates() {
    const now = Date.now();
    for (const [ state, pending ] of pendingOpenAiOauth.entries()) {
        if (now - pending.createdAt > OPENAI_OAUTH_PENDING_TIMEOUT_MS) {
            pendingOpenAiOauth.delete(state);
        }
    }
}

function sendOauthCallbackResponse(res: http.ServerResponse, status: number, body: string) {
    res.statusCode = status;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(body);
}

async function ensureOauthCallbackServer() {
    if (oauthCallbackServer) {
        return;
    }

    if (oauthCallbackServerStarting) {
        await oauthCallbackServerStarting;
        return;
    }

    oauthCallbackServerStarting = new Promise<void>((resolve, reject) => {
        const server = http.createServer(async (req, res) => {
            try {
                const parsedUrl = new URL(req.url || "/", `http://localhost:${OPENAI_OAUTH_CALLBACK_PORT}`);

                if (parsedUrl.pathname === OPENAI_OAUTH_CALLBACK_PATH) {
                    cleanupPendingOauthStates();

                    const code = parsedUrl.searchParams.get("code") || "";
                    const state = parsedUrl.searchParams.get("state") || "";
                    const providerError = parsedUrl.searchParams.get("error") || "";
                    const providerErrorDescription = parsedUrl.searchParams.get("error_description") || "";

                    if (providerError) {
                        sendOauthCallbackResponse(res, 200, callbackHtml("OpenAI OAuth failed", providerErrorDescription || providerError, true));
                        return;
                    }

                    if (!state) {
                        sendOauthCallbackResponse(res, 400, callbackHtml("OpenAI OAuth failed", "Missing OAuth state.", true));
                        return;
                    }

                    if (!code) {
                        sendOauthCallbackResponse(res, 400, callbackHtml("OpenAI OAuth failed", "Missing authorization code.", true));
                        return;
                    }

                    const pending = pendingOpenAiOauth.get(state);
                    pendingOpenAiOauth.delete(state);

                    if (!pending) {
                        sendOauthCallbackResponse(res, 400, callbackHtml("OpenAI OAuth failed", "Invalid or expired OAuth state.", true));
                        return;
                    }

                    try {
                        const tokens = await fetchOpenAiOauthToken(
                            new URLSearchParams({
                                grant_type: "authorization_code",
                                code,
                                redirect_uri: pending.redirectUri,
                                client_id: OPENAI_OAUTH_CLIENT_ID,
                                code_verifier: pending.verifier
                            })
                        );

                        await storeOauthTokens(tokens);

                        sendOauthCallbackResponse(res, 200, callbackHtml("OpenAI OAuth connected", "Your OpenAI OAuth credentials were saved successfully."));
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        log.error(`Failed completing OpenAI OAuth callback: ${message}`);
                        sendOauthCallbackResponse(res, 200, callbackHtml("OpenAI OAuth failed", message, true));
                    }

                    return;
                }

                if (parsedUrl.pathname === "/cancel") {
                    sendOauthCallbackResponse(res, 200, callbackHtml("OpenAI OAuth cancelled", "Login cancelled.", true));
                    return;
                }

                res.statusCode = 404;
                res.setHeader("Content-Type", "text/plain; charset=utf-8");
                res.end("Not found");
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                log.error(`OpenAI OAuth callback server error: ${message}`);
                res.statusCode = 500;
                res.setHeader("Content-Type", "text/plain; charset=utf-8");
                res.end("OAuth callback server error");
            }
        });

        server.on("error", (error) => reject(error));

        server.listen(OPENAI_OAUTH_CALLBACK_PORT, "127.0.0.1", () => {
            oauthCallbackServer = server;
            resolve();
        });
    })
        .finally(() => {
            oauthCallbackServerStarting = undefined;
        });

    await oauthCallbackServerStarting;
}

function escapeHtml(input: string) {
    return input
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll("\"", "&quot;")
        .replaceAll("'", "&#39;");
}

function callbackHtml(title: string, description: string, isError = false) {
    const safeDescription = escapeHtml(description);
    const headingColor = isError ? "#ff6f61" : "#7ed957";
    const autoCloseScript = isError
        ? ""
        : "<script>setTimeout(() => window.close(), 2000);</script>";

    return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Trilium - OpenAI OAuth</title>
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        background: #1d1f21;
        color: #f2f2f2;
      }
      .box {
        max-width: 640px;
        text-align: center;
        background: #2a2c2f;
        border: 1px solid #3b3e42;
        border-radius: 12px;
        padding: 24px;
      }
      h1 {
        margin-top: 0;
        color: ${headingColor};
      }
      p {
        color: #d5d7da;
        white-space: pre-wrap;
      }
    </style>
  </head>
  <body>
    <div class="box">
      <h1>${escapeHtml(title)}</h1>
      <p>${safeDescription}</p>
      <p>You can close this tab and return to Trilium.</p>
    </div>
    ${autoCloseScript}
  </body>
</html>`;
}

function toBase64Url(buffer: Buffer) {
    return buffer
        .toString("base64")
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/g, "");
}

function generateRandomString(length: number) {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
    return Array.from(randomBytes(length))
        .map((byte) => chars[byte % chars.length])
        .join("");
}

function generatePkcePair() {
    // Match OpenCode's PKCE verifier generation to avoid subtle provider-side validation issues.
    const verifier = generateRandomString(43);
    const challenge = toBase64Url(createHash("sha256").update(verifier).digest());
    return { verifier, challenge };
}

function generateState() {
    return toBase64Url(randomBytes(32));
}

function normalizeBaseUrl(baseUrl: string) {
    return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
}

async function fetchOpenAiOauthToken(body: URLSearchParams) {
    const response = await fetch(`${OPENAI_OAUTH_ISSUER}/oauth/token`, {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded"
        },
        body: body.toString()
    });

    const result = await response.json().catch(() => undefined);
    if (!response.ok || !result) {
        throw new Error(`OpenAI token request failed (${response.status})`);
    }

    return result as OpenAiOauthTokenResponse;
}

function decodeJwtClaims(token?: string): OpenAiJwtClaims | undefined {
    if (!token) {
        return undefined;
    }

    const parts = token.split(".");
    if (parts.length !== 3) {
        return undefined;
    }

    try {
        const payload = parts[1].replaceAll("-", "+").replaceAll("_", "/");
        const padding = "=".repeat((4 - (payload.length % 4)) % 4);
        const decoded = Buffer.from(`${payload}${padding}`, "base64").toString("utf8");
        return JSON.parse(decoded) as OpenAiJwtClaims;
    } catch {
        return undefined;
    }
}

function extractAccountId(claims: OpenAiJwtClaims | undefined) {
    if (!claims) {
        return "";
    }

    return claims.chatgpt_account_id
        || claims["https://api.openai.com/auth"]?.chatgpt_account_id
        || claims.organizations?.find(x => !!x.id)?.id
        || "";
}

async function storeOauthTokens(tokens: OpenAiOauthTokenResponse, currentAccountId = "", currentEmail = "") {
    const accessClaims = decodeJwtClaims(tokens.id_token) ?? decodeJwtClaims(tokens.access_token);
    const accountId = extractAccountId(accessClaims) || currentAccountId;
    const email = accessClaims?.email || currentEmail;
    const expiresAt = Date.now() + (tokens.expires_in || 3600) * 1000;

    optionService.setOption("openaiAuthMethod", "oauth");
    optionService.setOption("openaiOauthAccessToken", tokens.access_token);
    optionService.setOption("openaiOauthRefreshToken", tokens.refresh_token);
    optionService.setOption("openaiOauthExpiresAt", String(expiresAt));
    optionService.setOption("openaiOauthAccountId", accountId);
    optionService.setOption("openaiOauthEmail", email);
}

async function ensureOauthAccessToken() {
    const refreshToken = optionService.getOptionOrNull("openaiOauthRefreshToken") || "";
    const accessToken = optionService.getOptionOrNull("openaiOauthAccessToken") || "";
    const accountId = optionService.getOptionOrNull("openaiOauthAccountId") || "";
    const email = optionService.getOptionOrNull("openaiOauthEmail") || "";
    const expiresAt = parseInt(optionService.getOptionOrNull("openaiOauthExpiresAt") || "0", 10);

    if (accessToken && Date.now() + OPENAI_OAUTH_REFRESH_LEEWAY_MS < expiresAt) {
        return accessToken;
    }

    if (!refreshToken) {
        return "";
    }

    try {
        const refreshed = await fetchOpenAiOauthToken(
            new URLSearchParams({
                grant_type: "refresh_token",
                refresh_token: refreshToken,
                client_id: OPENAI_OAUTH_CLIENT_ID
            })
        );

        await storeOauthTokens(refreshed, accountId, email);
        return refreshed.access_token;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error(`Failed refreshing OpenAI OAuth token: ${message}`);
        return "";
    }
}

function getOauthStatus() {
    const method = optionService.getOptionOrNull("openaiAuthMethod") || "api";
    const refreshToken = optionService.getOptionOrNull("openaiOauthRefreshToken") || "";
    const accessToken = optionService.getOptionOrNull("openaiOauthAccessToken") || "";
    const expiresAt = parseInt(optionService.getOptionOrNull("openaiOauthExpiresAt") || "0", 10);
    const accountId = optionService.getOptionOrNull("openaiOauthAccountId") || "";
    const email = optionService.getOptionOrNull("openaiOauthEmail") || "";

    return {
        connected: method === "oauth" && !!refreshToken && !!accessToken,
        method,
        expiresAt,
        accountId,
        email
    };
}

async function authorizeOauth(req: Request) {
    cleanupPendingOauthStates();

    if (!isElectron) {
        return [400, { success: false, message: "OpenAI OAuth is only supported in the desktop app." }];
    }

    try {
        await ensureOauthCallbackServer();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error(`Failed starting OpenAI OAuth callback server: ${message}`);
        return [500, { success: false, message: `Failed starting OAuth callback server on port ${OPENAI_OAUTH_CALLBACK_PORT}: ${message}` }];
    }

    const { verifier, challenge } = generatePkcePair();
    const state = generateState();
    const redirectUri = OPENAI_OAUTH_REDIRECT_URI;

    pendingOpenAiOauth.set(state, {
        verifier,
        redirectUri,
        createdAt: Date.now()
    });

    const params = new URLSearchParams({
        response_type: "code",
        client_id: OPENAI_OAUTH_CLIENT_ID,
        redirect_uri: redirectUri,
        scope: OPENAI_OAUTH_SCOPE,
        code_challenge: challenge,
        code_challenge_method: "S256",
        id_token_add_organizations: "true",
        codex_cli_simplified_flow: "true",
        state,
        originator: "opencode"
    });

    return {
        url: `${OPENAI_OAUTH_ISSUER}/oauth/authorize?${params.toString()}`,
        expiresAt: Date.now() + OPENAI_OAUTH_PENDING_TIMEOUT_MS
    };
}

async function authorizeOauthDevice(req: Request) {
    if (!isElectron) {
        return [400, { success: false, message: "OpenAI OAuth is only supported in the desktop app." }];
    }

    try {
        if (deviceAuthCancelCurrent) {
            deviceAuthCancelCurrent();
            deviceAuthCancelCurrent = undefined;
            deviceAuthPollCurrent = undefined;
        }

        const response = await fetch(OPENAI_OAUTH_DEVICE_USERCODE_ENDPOINT, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                client_id: OPENAI_OAUTH_CLIENT_ID
            })
        });

        const result = await response.json().catch(() => undefined);
        if (!response.ok || !result) {
            throw new Error(`OpenAI device authorization failed (${response.status})`);
        }

        const deviceCode = result as OpenAiOauthDeviceCodeResponse;
        if (!deviceCode.device_auth_id || !deviceCode.user_code) {
            throw new Error("OpenAI device authorization response is missing required fields.");
        }

        const intervalMs = Math.max(parseInt(deviceCode.interval || "5", 10) || 5, 1) * 1000;
        const startedAt = Date.now();
        let cancelled = false;
        const cancel = () => {
            cancelled = true;
        };

        deviceAuthCancelCurrent = cancel;
        deviceAuthPollCurrent = (async () => {
            try {
                while (!cancelled && Date.now() - startedAt < OPENAI_OAUTH_PENDING_TIMEOUT_MS) {
                    const tokenResponse = await fetch(OPENAI_OAUTH_DEVICE_TOKEN_ENDPOINT, {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json"
                        },
                        body: JSON.stringify({
                            device_auth_id: deviceCode.device_auth_id,
                            user_code: deviceCode.user_code
                        })
                    });

                    if (tokenResponse.ok) {
                        const tokenData = await tokenResponse.json().catch(() => undefined) as OpenAiOauthDeviceTokenResponse | undefined;
                        if (!tokenData?.authorization_code || !tokenData.code_verifier) {
                            throw new Error("OpenAI device token response is missing required fields.");
                        }

                        const tokens = await fetchOpenAiOauthToken(
                            new URLSearchParams({
                                grant_type: "authorization_code",
                                code: tokenData.authorization_code,
                                redirect_uri: OPENAI_OAUTH_DEVICE_REDIRECT_URI,
                                client_id: OPENAI_OAUTH_CLIENT_ID,
                                code_verifier: tokenData.code_verifier
                            })
                        );

                        await storeOauthTokens(tokens);
                        return;
                    }

                    if (tokenResponse.status !== 403 && tokenResponse.status !== 404) {
                        const body = await tokenResponse.text();
                        log.error(`OpenAI device token polling failed (${tokenResponse.status}): ${body}`);
                        return;
                    }

                    await new Promise((resolve) => setTimeout(resolve, intervalMs + OPENAI_OAUTH_DEVICE_POLLING_SAFETY_MARGIN_MS));
                }
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                log.error(`OpenAI device authorization polling failed: ${message}`);
            }
        })().finally(() => {
            if (deviceAuthCancelCurrent === cancel) {
                deviceAuthCancelCurrent = undefined;
                deviceAuthPollCurrent = undefined;
            }
        });

        return {
            url: OPENAI_OAUTH_DEVICE_URL,
            userCode: deviceCode.user_code,
            expiresAt: startedAt + OPENAI_OAUTH_PENDING_TIMEOUT_MS
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error(`Failed starting OpenAI device authorization: ${message}`);
        return [500, { success: false, message }];
    }
}

async function oauthCallback(req: Request) {
    cleanupPendingOauthStates();

    const state = typeof req.query.state === "string" ? req.query.state : "";
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const providerError = typeof req.query.error === "string" ? req.query.error : "";
    const providerErrorDescription = typeof req.query.error_description === "string" ? req.query.error_description : "";

    if (providerError) {
        return callbackHtml("OpenAI OAuth failed", providerErrorDescription || providerError, true);
    }

    if (!state) {
        return callbackHtml("OpenAI OAuth failed", "Missing OAuth state.", true);
    }

    if (!code) {
        return callbackHtml("OpenAI OAuth failed", "Missing authorization code.", true);
    }

    const pending = pendingOpenAiOauth.get(state);
    pendingOpenAiOauth.delete(state);

    if (!pending) {
        return callbackHtml("OpenAI OAuth failed", "Invalid or expired OAuth state.", true);
    }

    try {
        const tokens = await fetchOpenAiOauthToken(
            new URLSearchParams({
                grant_type: "authorization_code",
                code,
                redirect_uri: pending.redirectUri,
                client_id: OPENAI_OAUTH_CLIENT_ID,
                code_verifier: pending.verifier
            })
        );

        await storeOauthTokens(tokens);

        return callbackHtml("OpenAI OAuth connected", "Your OpenAI OAuth credentials were saved successfully.");
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error(`Failed completing OpenAI OAuth callback: ${message}`);
        return callbackHtml("OpenAI OAuth failed", message, true);
    }
}

async function listModels(req: Request) {
    const baseUrlQuery = typeof req.query.baseUrl === "string" ? req.query.baseUrl : "";
    const baseUrl = baseUrlQuery.trim() || optionService.getOptionOrNull("openaiBaseUrl") || OPENAI_DEFAULT_BASE_URL;
    const authMethod = optionService.getOptionOrNull("openaiAuthMethod") || "api";

    if (authMethod === "oauth") {
        const accessToken = await ensureOauthAccessToken();
        if (!accessToken) {
            return [400, { success: false, message: "OpenAI OAuth is not connected." }];
        }

        return {
            success: true,
            chatModels: OPENAI_OAUTH_MODELS.map(model => ({
                id: model,
                name: model,
                type: "chat"
            }))
        };
    }

    const apiKey = optionService.getOptionOrNull("openaiApiKey") || "";
    if (!apiKey) {
        return [400, { success: false, message: "OpenAI API key is empty." }];
    }

    const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
    const endpoint = new URL("models", normalizedBaseUrl);

    const response = await fetch(endpoint, {
        headers: {
            Authorization: `Bearer ${apiKey}`
        }
    });

    if (!response.ok) {
        const body = await response.text();
        log.error(`OpenAI models request failed (${response.status}): ${body}`);
        return [response.status, { success: false, message: body || `OpenAI request failed (${response.status})` }];
    }

    const result = await response.json() as OpenAiModelListResponse;
    const chatModels = (result.data || [])
        .filter(model => !!model.id)
        .filter(model => !model.id!.includes("embedding") && !model.id!.includes("embed"))
        .map(model => ({
            id: model.id!,
            name: model.id!,
            type: "chat"
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

    return {
        success: true,
        chatModels
    };
}

async function listAnthropicModels(req: Request) {
    const baseUrlQuery = typeof req.query.baseUrl === "string" ? req.query.baseUrl : "";
    const baseUrl = baseUrlQuery.trim() || optionService.getOptionOrNull("anthropicBaseUrl") || ANTHROPIC_DEFAULT_BASE_URL;
    const apiKey = optionService.getOptionOrNull("anthropicApiKey") || "";

    if (!apiKey) {
        return [400, { success: false, message: "Anthropic API key is empty." }];
    }

    const endpoint = new URL("models", normalizeBaseUrl(baseUrl));
    const response = await fetch(endpoint, {
        headers: {
            "x-api-key": apiKey,
            "anthropic-version": ANTHROPIC_VERSION_HEADER
        }
    });

    if (!response.ok) {
        const body = await response.text();
        log.error(`Anthropic models request failed (${response.status}): ${body}`);
        return [response.status, { success: false, message: body || `Anthropic request failed (${response.status})` }];
    }

    const result = await response.json() as AnthropicModelListResponse;
    const chatModels = (result.data || [])
        .filter(model => !!model.id)
        .map(model => ({
            id: model.id!,
            name: model.display_name || model.id!,
            type: "chat"
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

    return {
        success: true,
        chatModels
    };
}

async function listOllamaModels(req: Request) {
    const baseUrlQuery = typeof req.query.baseUrl === "string" ? req.query.baseUrl : "";
    const baseUrl = baseUrlQuery.trim() || optionService.getOptionOrNull("ollamaBaseUrl") || OLLAMA_DEFAULT_BASE_URL;
    const endpoint = new URL("api/tags", normalizeBaseUrl(baseUrl));

    const response = await fetch(endpoint);
    if (!response.ok) {
        const body = await response.text();
        log.error(`Ollama models request failed (${response.status}): ${body}`);
        return [response.status, { success: false, message: body || `Ollama request failed (${response.status})` }];
    }

    const result = await response.json() as OllamaModelListResponse;
    const models = (result.models || [])
        .filter(model => !!model.model || !!model.name)
        .map(model => ({
            name: model.name || model.model!,
            model: model.model || model.name!,
            details: model.details
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

    return {
        success: true,
        models
    };
}

function disconnectOauth() {
    if (deviceAuthCancelCurrent) {
        deviceAuthCancelCurrent();
        deviceAuthCancelCurrent = undefined;
        deviceAuthPollCurrent = undefined;
    }

    optionService.setOption("openaiAuthMethod", "api");
    optionService.setOption("openaiOauthAccessToken", "");
    optionService.setOption("openaiOauthRefreshToken", "");
    optionService.setOption("openaiOauthExpiresAt", "0");
    optionService.setOption("openaiOauthAccountId", "");
    optionService.setOption("openaiOauthEmail", "");

    return {
        success: true
    };
}

export default {
    listModels,
    listAnthropicModels,
    listOllamaModels,
    authorizeOauth,
    authorizeOauthDevice,
    oauthCallback,
    getOauthStatus,
    disconnectOauth
};
