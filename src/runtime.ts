import type { PluginRuntime } from "moltbot/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setNdrRuntime(r: PluginRuntime): void {
  runtime = r;
}

export function getNdrRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("NDR runtime not initialized");
  }
  return runtime;
}
