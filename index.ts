import type { MoltbotPluginApi } from "moltbot/plugin-sdk";
import { emptyPluginConfigSchema } from "moltbot/plugin-sdk";

import { ndrPlugin } from "./src/channel.js";
import { setNdrRuntime } from "./src/runtime.js";

const plugin = {
  id: "ndr",
  name: "NDR",
  description: "Forward-secure E2E encryption via nostr-double-ratchet",
  configSchema: emptyPluginConfigSchema(),
  register(api: MoltbotPluginApi) {
    setNdrRuntime(api.runtime);
    api.registerChannel({ plugin: ndrPlugin });
  },
};

export default plugin;
