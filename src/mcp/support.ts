import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { HarnessError } from '../errors.js'

export function asToolResult(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] }
}

export function asTextResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] }
}

export function guard<A>(run: (args: A) => CallToolResult): (args: A) => CallToolResult {
  return (args) => {
    try {
      return run(args)
    } catch (error) {
      if (error instanceof HarnessError) {
        return {
          content: [{ type: 'text', text: `${error.code}: ${error.message}` }],
          isError: true,
        }
      }
      throw error
    }
  }
}
