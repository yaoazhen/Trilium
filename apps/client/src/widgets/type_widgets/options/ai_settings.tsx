import type { OllamaModelResponse, OpenAiOrAnthropicModelResponse } from "@triliumnext/commons";
import { useCallback, useEffect, useMemo, useState } from "preact/hooks";

import server from "../../../services/server";
import toast from "../../../services/toast";
import utils from "../../../services/utils";
import Button from "../../react/Button";
import FormCheckbox from "../../react/FormCheckbox";
import FormGroup from "../../react/FormGroup";
import FormSelect from "../../react/FormSelect";
import FormTextArea from "../../react/FormTextArea";
import FormTextBox from "../../react/FormTextBox";
import { useTriliumOption, useTriliumOptionBool } from "../../react/hooks";
import Admonition from "../../react/Admonition";
import OptionsSection from "./components/OptionsSection";

interface OpenAiOauthStatusResponse {
    connected: boolean;
    method: string;
    expiresAt: number;
    accountId: string;
    email: string;
}

type ProviderId = "openai" | "anthropic" | "ollama";

const WAIT_AFTER_OAUTH_START_MS = 2_000;
const OAUTH_STATUS_MAX_POLLS = 60;
const PROVIDERS: Array<{ value: ProviderId; text: string }> = [
    { value: "openai", text: "OpenAI" },
    { value: "anthropic", text: "Anthropic" },
    { value: "ollama", text: "Ollama" }
];

function normalizeProvider(value: string | undefined): ProviderId {
    if (value === "anthropic" || value === "ollama") {
        return value;
    }

    return "openai";
}

export default function AiSettings() {
    const [ aiEnabled, setAiEnabled ] = useTriliumOptionBool("aiEnabled");
    const [ aiSelectedProvider, setAiSelectedProvider ] = useTriliumOption("aiSelectedProvider");
    const [ aiTemperature, setAiTemperature ] = useTriliumOption("aiTemperature");
    const [ aiSystemPrompt, setAiSystemPrompt ] = useTriliumOption("aiSystemPrompt");
    const selectedProvider = normalizeProvider(aiSelectedProvider);

    return (
        <>
            <OptionsSection title="AI Settings">
                <FormGroup name="ai-enabled" description="Enable AI provider settings and model selection.">
                    <FormCheckbox
                        label="Enable AI features"
                        currentValue={aiEnabled}
                        onChange={(isEnabled) => {
                            setAiEnabled(isEnabled);
                            toast.showMessage(isEnabled ? "AI features enabled." : "AI features disabled.");
                        }}
                    />
                </FormGroup>

                {aiEnabled && (
                    <Admonition type="warning">
                        AI integration in Trilium is experimental.
                    </Admonition>
                )}
            </OptionsSection>

            <OptionsSection title="AI Provider Configuration">
                <FormGroup
                    name="selected-provider"
                    label="Selected provider"
                    description="Choose the AI provider used by chat and completion features."
                >
                    <FormSelect
                        values={PROVIDERS}
                        currentValue={selectedProvider}
                        onChange={(value) => setAiSelectedProvider(normalizeProvider(value))}
                        keyProperty="value"
                        titleProperty="text"
                    />
                </FormGroup>

                {selectedProvider === "openai" && <OpenAiProviderSettings />}
                {selectedProvider === "anthropic" && <AnthropicProviderSettings />}
                {selectedProvider === "ollama" && <OllamaProviderSettings />}

                <FormGroup
                    name="temperature"
                    label="Temperature"
                    description="Controls randomness in responses (0 = deterministic, 2 = most random)."
                >
                    <FormTextBox
                        type="number"
                        min="0"
                        max="2"
                        step="0.1"
                        currentValue={aiTemperature}
                        onChange={setAiTemperature}
                    />
                </FormGroup>

                <FormGroup
                    name="system-prompt"
                    label="System prompt"
                    description="Default system prompt used for AI interactions."
                >
                    <FormTextArea
                        rows={3}
                        currentValue={aiSystemPrompt}
                        onBlur={setAiSystemPrompt}
                    />
                </FormGroup>
            </OptionsSection>
        </>
    );
}

function OpenAiProviderSettings() {
    const [ openaiAuthMethod, setOpenaiAuthMethod ] = useTriliumOption("openaiAuthMethod");
    const [ openaiApiKey, setOpenaiApiKey ] = useTriliumOption("openaiApiKey");
    const [ openaiBaseUrl, setOpenaiBaseUrl ] = useTriliumOption("openaiBaseUrl");
    const [ oauthStatus, setOauthStatus ] = useState<OpenAiOauthStatusResponse | null>(null);
    const [ oauthBusy, setOauthBusy ] = useState(false);
    const [ oauthDeviceCode, setOauthDeviceCode ] = useState<string>("");

    const authMethod = openaiAuthMethod || "api";

    const loadOauthStatus = useCallback(async () => {
        try {
            const status = await server.get<OpenAiOauthStatusResponse>("llm/providers/openai/oauth/status");
            setOauthStatus(status);
            return status;
        } catch (error) {
            toast.showError(`Failed to read OpenAI OAuth status: ${error}`);
            return null;
        }
    }, []);

    useEffect(() => {
        if (authMethod !== "oauth") {
            return;
        }

        loadOauthStatus();
    }, [ authMethod, loadOauthStatus ]);

    const isConfigurationValid = useMemo(() => {
        if (authMethod === "oauth") {
            return !!oauthStatus?.connected;
        }

        return !!openaiApiKey;
    }, [ authMethod, oauthStatus?.connected, openaiApiKey ]);

    const openExternal = useCallback(async (url: string) => {
        if (utils.isElectron()) {
            try {
                const electron = utils.dynamicRequire("electron");
                await electron.shell.openExternal(url);
                return;
            } catch (error) {
                console.error("Failed to open external browser automatically, falling back to window.open", error);
            }
        }

        window.open(url, "_blank", "noopener,noreferrer");
    }, []);

    const connectWithOauth = useCallback(async () => {
        try {
            setOauthBusy(true);
            const result = await server.post<{ url: string }>("llm/providers/openai/oauth/authorize");
            setOauthDeviceCode("");
            await openExternal(result.url);

            for (let i = 0; i < OAUTH_STATUS_MAX_POLLS; i++) {
                await new Promise((resolve) => setTimeout(resolve, WAIT_AFTER_OAUTH_START_MS));
                const status = await loadOauthStatus();
                if (status?.connected) {
                    toast.showMessage("OpenAI OAuth connected.");
                    break;
                }
            }
        } catch (error) {
            toast.showError(`Failed to start OpenAI OAuth: ${error}`);
        } finally {
            setOauthBusy(false);
        }
    }, [ loadOauthStatus, openExternal ]);

    const connectWithOauthDevice = useCallback(async () => {
        try {
            setOauthBusy(true);
            const result = await server.post<{ url: string; userCode: string }>("llm/providers/openai/oauth/authorize-device");
            setOauthDeviceCode(result.userCode);
            toast.showMessage(`OpenAI device code: ${result.userCode}`);
            await openExternal(result.url);

            for (let i = 0; i < OAUTH_STATUS_MAX_POLLS; i++) {
                await new Promise((resolve) => setTimeout(resolve, WAIT_AFTER_OAUTH_START_MS));
                const status = await loadOauthStatus();
                if (status?.connected) {
                    toast.showMessage("OpenAI OAuth connected.");
                    break;
                }
            }
        } catch (error) {
            toast.showError(`Failed to start OpenAI device authorization: ${error}`);
        } finally {
            setOauthBusy(false);
        }
    }, [ loadOauthStatus, openExternal ]);

    const copyDeviceCode = useCallback(async () => {
        if (!oauthDeviceCode) {
            return;
        }

        try {
            await navigator.clipboard.writeText(oauthDeviceCode);
            toast.showMessage("Device code copied.");
        } catch (error) {
            toast.showError(`Failed to copy device code: ${error}`);
        }
    }, [ oauthDeviceCode ]);

    const changeAuthMethod = useCallback((value: string) => {
        setOpenaiAuthMethod(value);
        if (value !== "oauth") {
            setOauthDeviceCode("");
        }

        const switchedToOauth = authMethod !== "oauth" && value === "oauth";
        if (switchedToOauth && !oauthStatus?.connected && !oauthBusy) {
            void connectWithOauth();
        }
    }, [ authMethod, connectWithOauth, oauthBusy, oauthStatus?.connected, setOpenaiAuthMethod, setOauthDeviceCode ]);

    const disconnectOauth = useCallback(async () => {
        try {
            setOauthBusy(true);
            setOauthDeviceCode("");
            await server.post("llm/providers/openai/oauth/disconnect");
            await loadOauthStatus();
            toast.showMessage("OpenAI OAuth disconnected.");
        } catch (error) {
            toast.showError(`Failed to disconnect OpenAI OAuth: ${error}`);
        } finally {
            setOauthBusy(false);
        }
    }, [ loadOauthStatus ]);

    return (
        <div class="provider-settings">
            <div class="card mt-3">
                <div class="card-header">
                    <h5>OpenAI Settings</h5>
                </div>
                <div class="card-body">
                    <FormGroup
                        name="openai-auth-method"
                        label="Authentication method"
                        description="Use an API key or connect with OpenAI OAuth for ChatGPT Team/Pro accounts."
                    >
                        <FormSelect
                            values={[
                                { value: "api", text: "API key" },
                                { value: "oauth", text: "OpenAI OAuth (ChatGPT Team/Pro)" }
                            ]}
                            currentValue={authMethod}
                            onChange={changeAuthMethod}
                            keyProperty="value"
                            titleProperty="text"
                        />
                    </FormGroup>

                    {authMethod === "api" && (
                        <FormGroup
                            name="openai-api-key"
                            label="API key"
                            description="Your OpenAI API key for OpenAI-compatible API access."
                        >
                            <FormTextBox
                                type="password"
                                autoComplete="off"
                                currentValue={openaiApiKey}
                                onChange={setOpenaiApiKey}
                            />
                        </FormGroup>
                    )}

                    {authMethod === "oauth" && (
                        <FormGroup
                            name="openai-oauth"
                            label="OpenAI OAuth"
                            description="Connect Trilium to your OpenAI account using OAuth. If the browser flow fails, try the device code method."
                        >
                            <div>
                                <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
                                    <Button
                                        text={oauthStatus?.connected ? "Reconnect OAuth" : "Connect OAuth"}
                                        onClick={connectWithOauth}
                                        disabled={oauthBusy}
                                    />
                                    <Button
                                        text="Device Code Login"
                                        kind="lowProfile"
                                        onClick={connectWithOauthDevice}
                                        disabled={oauthBusy}
                                    />
                                    <Button
                                        text="Disconnect OAuth"
                                        kind="lowProfile"
                                        onClick={disconnectOauth}
                                        disabled={oauthBusy || !oauthStatus?.connected}
                                    />
                                </div>
                                {!!oauthDeviceCode && !oauthStatus?.connected && (
                                    <div style={{ marginTop: "0.75rem" }}>
                                        <div style={{ fontWeight: 600 }}>Device code</div>
                                        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
                                            <code style={{ padding: "0.25rem 0.5rem", background: "rgba(255,255,255,0.06)", borderRadius: "6px" }}>
                                                {oauthDeviceCode}
                                            </code>
                                            <Button
                                                text="Copy"
                                                size="small"
                                                kind="lowProfile"
                                                onClick={copyDeviceCode}
                                            />
                                        </div>
                                    </div>
                                )}
                                {oauthStatus?.connected && (
                                    <div style={{ marginTop: "0.5rem" }}>
                                        Connected{oauthStatus.email ? ` as ${oauthStatus.email}` : ""}{oauthStatus.accountId ? ` (account: ${oauthStatus.accountId})` : ""}.
                                    </div>
                                )}
                            </div>
                        </FormGroup>
                    )}

                    {!isConfigurationValid && (
                        <Admonition type="caution">
                            {authMethod === "oauth"
                                ? "OpenAI OAuth is not connected. Please connect your account."
                                : "OpenAI API key is empty. Please enter a valid API key."}
                        </Admonition>
                    )}

                    <FormGroup
                        name="openai-base-url"
                        label="Base URL"
                        description="Default: https://api.openai.com/v1"
                    >
                        <FormTextBox
                            currentValue={openaiBaseUrl || "https://api.openai.com/v1"}
                            onChange={setOpenaiBaseUrl}
                        />
                    </FormGroup>

                    {isConfigurationValid && (
                        <FormGroup
                            name="openai-model"
                            label="Model"
                            description="Select the default OpenAI model."
                        >
                            <OpenAiModelSelector baseUrl={openaiBaseUrl || "https://api.openai.com/v1"} />
                        </FormGroup>
                    )}
                </div>
            </div>
        </div>
    );
}

function OpenAiModelSelector({ baseUrl }: { baseUrl: string }) {
    const [ openaiDefaultModel, setOpenaiDefaultModel ] = useTriliumOption("openaiDefaultModel");
    const [ models, setModels ] = useState<{ id: string; name: string }[]>([]);

    const loadModels = useCallback(async () => {
        try {
            const response = await server.get<OpenAiOrAnthropicModelResponse>(`llm/providers/openai/models?baseUrl=${encodeURIComponent(baseUrl)}`);
            if (!response.success) {
                toast.showError("No models found for OpenAI. Check your provider configuration.");
                return;
            }

            const sortedModels = response.chatModels
                .map(model => ({ id: model.id, name: model.name }))
                .toSorted((a, b) => a.name.localeCompare(b.name));

            setModels(sortedModels);
        } catch (error) {
            toast.showError(`Error fetching OpenAI models: ${error}`);
        }
    }, [ baseUrl ]);

    useEffect(() => {
        loadModels();
    }, [ loadModels ]);

    return (
        <>
            <FormSelect
                values={models}
                currentValue={openaiDefaultModel}
                onChange={setOpenaiDefaultModel}
                keyProperty="id"
                titleProperty="name"
            />
            <Button
                text="Refresh Models"
                onClick={loadModels}
                size="small"
                style={{ marginTop: "0.5em" }}
            />
        </>
    );
}

function AnthropicProviderSettings() {
    const [ anthropicApiKey, setAnthropicApiKey ] = useTriliumOption("anthropicApiKey");
    const [ anthropicBaseUrl, setAnthropicBaseUrl ] = useTriliumOption("anthropicBaseUrl");
    const isConfigurationValid = !!anthropicApiKey;

    return (
        <div class="provider-settings">
            <div class="card mt-3">
                <div class="card-header">
                    <h5>Anthropic Settings</h5>
                </div>
                <div class="card-body">
                    {!isConfigurationValid && (
                        <Admonition type="caution">
                            Anthropic API key is empty. Please enter a valid API key.
                        </Admonition>
                    )}

                    <FormGroup
                        name="anthropic-api-key"
                        label="API key"
                        description="Your Anthropic API key."
                    >
                        <FormTextBox
                            type="password"
                            autoComplete="off"
                            currentValue={anthropicApiKey}
                            onChange={setAnthropicApiKey}
                        />
                    </FormGroup>

                    <FormGroup
                        name="anthropic-base-url"
                        label="Base URL"
                        description="Default: https://api.anthropic.com/v1"
                    >
                        <FormTextBox
                            currentValue={anthropicBaseUrl || "https://api.anthropic.com/v1"}
                            onChange={setAnthropicBaseUrl}
                        />
                    </FormGroup>

                    {isConfigurationValid && (
                        <FormGroup
                            name="anthropic-model"
                            label="Model"
                            description="Select the default Anthropic model."
                        >
                            <AnthropicModelSelector baseUrl={anthropicBaseUrl || "https://api.anthropic.com/v1"} />
                        </FormGroup>
                    )}
                </div>
            </div>
        </div>
    );
}

function AnthropicModelSelector({ baseUrl }: { baseUrl: string }) {
    const [ anthropicDefaultModel, setAnthropicDefaultModel ] = useTriliumOption("anthropicDefaultModel");
    const [ models, setModels ] = useState<{ id: string; name: string }[]>([]);

    const loadModels = useCallback(async () => {
        try {
            const response = await server.get<OpenAiOrAnthropicModelResponse>(`llm/providers/anthropic/models?baseUrl=${encodeURIComponent(baseUrl)}`);
            if (!response.success) {
                toast.showError("No models found for Anthropic. Check your provider configuration.");
                return;
            }

            const sortedModels = response.chatModels
                .map(model => ({ id: model.id, name: model.name }))
                .toSorted((a, b) => a.name.localeCompare(b.name));

            setModels(sortedModels);
        } catch (error) {
            toast.showError(`Error fetching Anthropic models: ${error}`);
        }
    }, [ baseUrl ]);

    useEffect(() => {
        loadModels();
    }, [ loadModels ]);

    return (
        <>
            <FormSelect
                values={models}
                currentValue={anthropicDefaultModel}
                onChange={setAnthropicDefaultModel}
                keyProperty="id"
                titleProperty="name"
            />
            <Button
                text="Refresh Models"
                onClick={loadModels}
                size="small"
                style={{ marginTop: "0.5em" }}
            />
        </>
    );
}

function OllamaProviderSettings() {
    const [ ollamaBaseUrl, setOllamaBaseUrl ] = useTriliumOption("ollamaBaseUrl");
    const hasBaseUrl = !!(ollamaBaseUrl || "http://localhost:11434").trim();

    return (
        <div class="provider-settings">
            <div class="card mt-3">
                <div class="card-header">
                    <h5>Ollama Settings</h5>
                </div>
                <div class="card-body">
                    {!hasBaseUrl && (
                        <Admonition type="caution">
                            Ollama base URL is empty. Please enter a valid URL.
                        </Admonition>
                    )}

                    <FormGroup
                        name="ollama-base-url"
                        label="Base URL"
                        description="Default: http://localhost:11434"
                    >
                        <FormTextBox
                            currentValue={ollamaBaseUrl || "http://localhost:11434"}
                            onChange={setOllamaBaseUrl}
                        />
                    </FormGroup>

                    {hasBaseUrl && (
                        <FormGroup
                            name="ollama-model"
                            label="Model"
                            description="Select the default Ollama model."
                        >
                            <OllamaModelSelector baseUrl={ollamaBaseUrl || "http://localhost:11434"} />
                        </FormGroup>
                    )}
                </div>
            </div>
        </div>
    );
}

function OllamaModelSelector({ baseUrl }: { baseUrl: string }) {
    const [ ollamaDefaultModel, setOllamaDefaultModel ] = useTriliumOption("ollamaDefaultModel");
    const [ models, setModels ] = useState<{ id: string; name: string }[]>([]);

    const loadModels = useCallback(async () => {
        try {
            const response = await server.get<OllamaModelResponse>(`llm/providers/ollama/models?baseUrl=${encodeURIComponent(baseUrl)}`);
            if (!response.success) {
                toast.showError("No models found for Ollama. Check your provider configuration.");
                return;
            }

            const sortedModels = response.models
                .map(model => ({
                    id: model.model || model.name,
                    name: model.name || model.model
                }))
                .filter((model): model is { id: string; name: string } => !!model.id && !!model.name)
                .toSorted((a, b) => a.name.localeCompare(b.name));

            setModels(sortedModels);
        } catch (error) {
            toast.showError(`Error fetching Ollama models: ${error}`);
        }
    }, [ baseUrl ]);

    useEffect(() => {
        loadModels();
    }, [ loadModels ]);

    return (
        <>
            <FormSelect
                values={models}
                currentValue={ollamaDefaultModel}
                onChange={setOllamaDefaultModel}
                keyProperty="id"
                titleProperty="name"
            />
            <Button
                text="Refresh Models"
                onClick={loadModels}
                size="small"
                style={{ marginTop: "0.5em" }}
            />
        </>
    );
}
