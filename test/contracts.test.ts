import { describe, expect, it } from 'vitest'
import { createTestHarness } from './support.js'

describe('protocol contract', () => {
  it('matches the recorded tool, resource, template and prompt surface', async () => {
    const harness = await createTestHarness()
    try {
      const tools = await harness.client.listTools()
      const resources = await harness.client.listResources()
      const templates = await harness.client.listResourceTemplates()
      const prompts = await harness.client.listPrompts()
      const surface = {
        tools: tools.tools.map((tool) => ({
          name: tool.name,
          title: tool.title ?? null,
          inputSchema: tool.inputSchema,
          annotations: tool.annotations ?? null,
        })),
        resources: resources.resources.map((resource) => ({
          uri: resource.uri,
          name: resource.name,
        })),
        resourceTemplates: templates.resourceTemplates.map((template) => ({
          uriTemplate: template.uriTemplate,
          name: template.name,
        })),
        prompts: prompts.prompts.map((prompt) => ({
          name: prompt.name,
          arguments: (prompt.arguments ?? []).map((argument) => ({
            name: argument.name,
            required: argument.required ?? false,
            description: argument.description ?? null,
          })),
        })),
      }
      await expect(`${JSON.stringify(surface, null, 2)}\n`).toMatchFileSnapshot(
        './contracts/harness-surface.json',
      )
    } finally {
      await harness.dispose()
    }
  })
})
