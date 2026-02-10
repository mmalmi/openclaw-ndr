// Suppress deprecation warnings from peer dependencies during tests.
process.noDeprecation = true;

// Tests should not depend on whatever happens to be in the developer's
// ~/.openclaw/openclaw.json, since that can produce noisy diagnostics.
import { fileURLToPath } from "node:url";
const fixtureConfigPath = fileURLToPath(new URL("./fixtures/openclaw.empty.json", import.meta.url));
process.env.OPENCLAW_CONFIG_PATH = fixtureConfigPath;
