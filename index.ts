import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";

import { ndrPlugin } from "./src/channel.js";
import { setNdrRuntime } from "./src/runtime.js";

const plugin = {
  id: "openclaw-ndr",
  name: "NDR",
  description: "Forward-secure E2E encryption via nostr-double-ratchet",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setNdrRuntime(api.runtime);
    api.registerChannel({ plugin: ndrPlugin });
  },
};

export default plugin;
