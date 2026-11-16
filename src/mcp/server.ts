import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { SERVER_NAME, SERVER_VERSION } from '../config.js'
import type { HarnessStore } from '../store.js'
import { registerHarnessPrompts } from './prompts.js'
import { registerHarnessResources } from './resources.js'
import { registerHandoffTools } from './tools/handoff.js'
import { registerInsightTools } from './tools/insight.js'
import { registerKnowledgeTools } from './tools/knowledge.js'
import { registerPlanTools } from './tools/plan.js'
import { registerPortabilityTools } from './tools/portability.js'
import { registerProgressTools } from './tools/progress.js'
import { registerTaskTools } from './tools/tasks.js'

export function buildHarnessServer(store: HarnessStore): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION })
  registerTaskTools(server, store)
  registerProgressTools(server, store)
  registerHandoffTools(server, store)
  registerPlanTools(server, store)
  registerInsightTools(server, store)
  registerKnowledgeTools(server, store)
  registerPortabilityTools(server, store)
  registerHarnessPrompts(server, store)
  registerHarnessResources(server, store)
  return server
}
