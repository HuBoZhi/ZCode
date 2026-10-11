import type { ProviderEndpointRoutingPort } from "@zcode/contracts";
import type { ProviderEndpointRoutingFactoryOptions } from "../provider-endpoint-routing-options.js";

export function createProviderEndpointRoutingPort(
  _options: ProviderEndpointRoutingFactoryOptions,
): ProviderEndpointRoutingPort {
  // fork 的 PAT 在 BigModel 直连有效，默认改写到 ZCode ultra 网关会返回 401/1002。
  // 在 edition 边界保留配置端点，公共路由接线和请求期鉴权仍沿用原有合同。
  return {
    async resolve(requestUrl) {
      return { routed: false, url: requestUrl };
    },
  };
}
