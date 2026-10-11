import { describe, expect, it, vi } from "vitest";
import { createProviderEndpointRoutingPort } from "../src/model/endpoint-routing-edition/index.js";
import { createProviderEndpointRoutingFetch } from "../src/model/provider-endpoint-routing-fetch.js";

describe("fork default model endpoint routing", () => {
  it("sends a BigModel PAT request to its configured endpoint with streaming semantics intact", async () => {
    const url = "https://open.bigmodel.cn/api/anthropic/v1/messages?request=a%2Bb";
    const controller = new AbortController();
    const body = JSON.stringify({
      model: "GLM-5.3",
      max_tokens: 8,
      stream: true,
      system: "connectivity probe",
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "enabled", budget_tokens: 1024 },
      tools: [{ name: "probe", input_schema: { type: "object", properties: {} } }],
    });
    const request = new Request(url, {
      method: "POST",
      headers: { "x-api-key": "test-project-pat", Authorization: "Bearer test-project-pat" },
      body,
      signal: controller.signal,
    });
    const response = new Response("event: message_stop\ndata: {}\n\n", {
      headers: { "content-type": "text/event-stream" },
    });
    const configurationRequest = vi.fn(() => {
      throw new Error("unexpected configuration IO");
    });
    const sourceHeaders = vi.fn(() => ({}));
    let sent: Request | undefined;
    const transport = createProviderEndpointRoutingFetch({
      routingPort: createProviderEndpointRoutingPort({
        endpointOrigin: "https://gateway.example.test",
        httpClient: { request: configurationRequest },
        sourceHeaders,
      }),
      apiKeyId: "test-project-key-id",
      fetch: async (input, init) => {
        sent = new Request(input, init);
        return response;
      },
    });

    expect(await transport(request)).toBe(response);
    expect(sent?.url).toBe(url);
    expect(sent?.method).toBe("POST");
    expect(sent?.headers.get("x-api-key")).toBe("test-project-pat");
    expect(sent?.headers.get("authorization")).toBe("Bearer test-project-pat");
    await expect(sent?.text()).resolves.toBe(body);
    controller.abort();
    expect(sent?.signal.aborted).toBe(true);
    await expect(response.text()).resolves.toBe("event: message_stop\ndata: {}\n\n");
    expect(configurationRequest).not.toHaveBeenCalled();
    expect(sourceHeaders).not.toHaveBeenCalled();
  });

  it.each([
    "https://api.z.ai/api/anthropic/v1/messages?request=a%2Bb",
    "https://OPEN.BIGMODEL.CN:443/api/anthropic/v1/messages/?empty=",
    "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions",
    "https://provider.example.test/v1/messages",
  ])("preserves the configured URL exactly: %s", async (url) => {
    const configurationRequest = vi.fn(() => {
      throw new Error("unexpected configuration IO");
    });
    const sourceHeaders = vi.fn(() => ({}));
    const port = createProviderEndpointRoutingPort({
      endpointOrigin: "https://gateway.example.test",
      httpClient: { request: configurationRequest },
      sourceHeaders,
    });
    await expect(port.resolve(url, { apiKeyId: "test-project-key-id" })).resolves.toEqual({
      routed: false,
      url,
    });
    expect(configurationRequest).not.toHaveBeenCalled();
    expect(sourceHeaders).not.toHaveBeenCalled();
  });
});
