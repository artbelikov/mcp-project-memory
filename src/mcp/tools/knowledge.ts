import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import {
  FACT_KINDS,
  FACT_ORIGINS,
  type FactKind,
  type FactOrigin,
} from '../../repositories/facts.js'
import { TRAVERSAL_DIRECTIONS, type TraversalDirection } from '../../repositories/graph.js'
import type { HarnessStore } from '../../store.js'
import {
  MAX_FACT_BODY_LENGTH,
  MAX_FACT_NOTE_LENGTH,
  MAX_FACT_TITLE_LENGTH,
  MAX_LINK_REL_LENGTH,
  MAX_SEARCH_QUERY_LENGTH,
} from '../../util.js'
import { asToolResult, guard } from '../support.js'

export function registerKnowledgeTools(server: McpServer, store: HarnessStore): void {
  server.registerTool(
    'fact_add',
    {
      title: 'Record knowledge fact',
      description:
        'Record a durable piece of project knowledge the moment you discover it — a gotcha, an observed API behavior, an insight, or a note (title ≤160 chars, body ≤8000 chars). A stable F-number is auto-assigned and IMMUTABLE; the log is append-only. Use `decision_append` instead for binding rules/choices with rationale; facts are observations and quirks, and they LINK to the things they are about. `kind`: gotcha | api-fact | insight | note. `origin`: user (stated by a human) or agent (inferred by you, default) — user facts rank higher. `confidence` 0..1 down-ranks uncertain inferences. Pass `links` to attach relations in the same call (e.g. {rel:"affects", dst:"entity:storage-layer"}, {rel:"discovered-in", dst:"task:T3"}); dst is a typed ref fact:F1 | decision:D5 | task:T3 | plan:scope | entity:name (entities are auto-created, name ≤120 chars). `supersedes` retires an older fact by reference instead of editing history. `validFrom`/`validTo` (YYYY-MM-DD) bound when the fact is true; expired and superseded facts are hidden from search by default. The result includes `similar` existing facts — check them and supersede rather than duplicating.',
      inputSchema: {
        kind: z.enum(FACT_KINDS),
        title: z
          .string()
          .describe(`Short fact headline; non-empty, max ${MAX_FACT_TITLE_LENGTH} characters`),
        body: z
          .string()
          .describe(`The observation itself; non-empty, max ${MAX_FACT_BODY_LENGTH} characters`),
        origin: z.enum(FACT_ORIGINS).optional(),
        confidence: z.number().min(0).max(1).optional(),
        taskId: z.string().optional(),
        supersedes: z.string().optional(),
        validFrom: z.string().optional(),
        validTo: z.string().optional(),
        links: z
          .array(
            z.object({
              rel: z
                .string()
                .describe(`Lowercase-hyphen relation slug; max ${MAX_LINK_REL_LENGTH} characters`),
              dst: z
                .string()
                .describe('Typed ref: fact:F1 | decision:D5 | task:T3 | plan:scope | entity:name'),
            }),
          )
          .optional(),
      },
    },
    guard(
      (args: {
        kind: FactKind
        title: string
        body: string
        origin?: FactOrigin
        confidence?: number
        taskId?: string
        supersedes?: string
        validFrom?: string
        validTo?: string
        links?: { rel: string; dst: string }[]
      }) => asToolResult(store.facts.append(args)),
    ),
  )

  server.registerTool(
    'fact_get',
    {
      title: 'Get fact',
      description:
        'Fetch one fact by its exact F-number, including its body, provenance, validity window, what it supersedes, every typed link touching it, and its confirmation history (all `fact_confirm` re-verifications with `lastConfirmedAt`).',
      inputSchema: { ref: z.string() },
      annotations: { readOnlyHint: true },
    },
    guard((args: { ref: string }) => asToolResult(store.facts.detail(args.ref))),
  )

  server.registerTool(
    'fact_confirm',
    {
      title: 'Re-confirm fact',
      description:
        'Re-stamp a fact as still true when you re-observe it, without editing its content (facts stay append-only). Appends a confirmation with today’s timestamp and an optional `note` (≤200 chars); `fact_get` and the knowledge health report use the latest confirmation to decide staleness — a fact confirmed recently is never stale. Confirm a fact whenever a search or a live probe re-validates it.',
      inputSchema: {
        ref: z.string().describe('Exact F-number of the fact (e.g. F12)'),
        note: z
          .string()
          .optional()
          .describe(
            `Optional evidence for the re-confirmation; max ${MAX_FACT_NOTE_LENGTH} characters`,
          ),
      },
    },
    guard((args: { ref: string; note?: string }) =>
      asToolResult(store.facts.confirm(args.ref, args.note)),
    ),
  )

  server.registerTool(
    'fact_health',
    {
      title: 'Knowledge health',
      description:
        'Report knowledge-base hygiene: `orphanFacts` (nothing links to them and they touch no task or supersede chain), `duplicatePairs` (facts whose titles match each other both ways — supersede instead of keeping both; scanned across the 100 newest facts, max 50 pairs), `unusedEntities` (entities with no edges), and `staleFacts` (not re-confirmed for 90+ days — re-confirm or supersede them). Lists are capped at 100 samples; counts are exact except duplicates. Run it when the base feels noisy or before a big recording session.',
      annotations: { readOnlyHint: true },
    },
    guard(() => asToolResult(store.facts.health())),
  )

  server.registerTool(
    'entity_merge',
    {
      title: 'Merge entities',
      description:
        'Merge two entity nodes (`entity:from` → `entity:to`): every link pointing at or from `from` is moved to `to` (duplicates collapse, self-loops drop), then `from` is deleted. Both entities must already exist. Use it to fold aliases (`storage-layer` vs `storage layer`) that auto-creation split apart. The merge is atomic.',
      inputSchema: { from: z.string(), to: z.string() },
    },
    guard((args: { from: string; to: string }) =>
      asToolResult(store.graph.mergeEntities(args.from, args.to)),
    ),
  )

  server.registerTool(
    'fact_search',
    {
      title: 'Search knowledge',
      description:
        'Ranked full-text search over the knowledge base (FTS5 + bm25, porter-stemmed, so "polling" matches "polls"). Tolerates paraphrase far better than substring search. Results carry a snippet and a rank; user-stated and high-confidence facts rank above uncertain agent inferences; superseded and expired facts are hidden unless `includeSuperseded` is true. Filter by `kind`, `origin`, `taskId`, or `entity` (facts linked to that component/file/technology). Paginate with `limit` + `offset` (offset defaults to 0). Omit `query` to list recent facts; a non-empty `query` is ≤120 chars. Consult this BEFORE touching a component or repeating an investigation — the answer may already be recorded.',
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe(`Search terms; max ${MAX_SEARCH_QUERY_LENGTH} characters when present`),
        kind: z.enum(FACT_KINDS).optional(),
        origin: z.enum(FACT_ORIGINS).optional(),
        taskId: z.string().optional(),
        entity: z.string().optional(),
        includeSuperseded: z.boolean().optional(),
        limit: z.number().int().min(1).max(50).optional(),
        offset: z.number().int().min(0).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    guard(
      (args: {
        query?: string
        kind?: FactKind
        origin?: FactOrigin
        taskId?: string
        entity?: string
        includeSuperseded?: boolean
        limit?: number
        offset?: number
      }) => asToolResult({ facts: store.facts.search(args) }),
    ),
  )

  server.registerTool(
    'fact_link',
    {
      title: 'Link knowledge',
      description:
        'Add a typed relation between two nodes: `src` and `dst` are kind:id refs (fact:F1, decision:D5, task:T3, plan:scope, entity:storage-layer). `rel` is a short lowercase-hyphen slug (affects, discovered-in, uses, about, implements, relates-to…). Entity nodes are auto-created; other nodes must exist. Idempotent — linking the same triple twice is a no-op. Use this to weave facts into the project graph so retrieval can walk from a component to everything known about it.',
      inputSchema: {
        src: z
          .string()
          .describe('Typed ref: fact:F1 | decision:D5 | task:T3 | plan:scope | entity:name'),
        rel: z
          .string()
          .describe(
            `Lowercase-hyphen relation slug (affects, uses, about…); max ${MAX_LINK_REL_LENGTH} characters`,
          ),
        dst: z
          .string()
          .describe('Typed ref: fact:F1 | decision:D5 | task:T3 | plan:scope | entity:name'),
      },
    },
    guard((args: { src: string; rel: string; dst: string }) =>
      asToolResult(store.graph.link(args.src, args.rel, args.dst)),
    ),
  )

  server.registerTool(
    'fact_unlink',
    {
      title: 'Unlink knowledge',
      description:
        'Remove a typed relation (same src/rel/dst triple as fact_link). Links are associations, not history, so removing a wrong edge is allowed; facts and decisions themselves are never deleted.',
      inputSchema: {
        src: z
          .string()
          .describe('Typed ref: fact:F1 | decision:D5 | task:T3 | plan:scope | entity:name'),
        rel: z
          .string()
          .describe(
            `Lowercase-hyphen relation slug (affects, uses, about…); max ${MAX_LINK_REL_LENGTH} characters`,
          ),
        dst: z
          .string()
          .describe('Typed ref: fact:F1 | decision:D5 | task:T3 | plan:scope | entity:name'),
      },
    },
    guard((args: { src: string; rel: string; dst: string }) =>
      asToolResult(store.graph.unlink(args.src, args.rel, args.dst)),
    ),
  )

  server.registerTool(
    'fact_neighbourhood',
    {
      title: 'Knowledge neighbourhood',
      description:
        'Walk the project knowledge graph from a start node (kind:id) up to `depth` hops (1-5, default 2) in `direction` both|out|in. Returns the reachable nodes with labels and the edges among them — e.g. start at entity:storage-layer to see every fact, decision and task that touches it, or start at fact:F1 to see what it relates to. Use for impact questions ("what do we know about this component?") instead of grepping.',
      inputSchema: {
        start: z.string(),
        depth: z.number().int().min(1).max(5).optional(),
        direction: z.enum(TRAVERSAL_DIRECTIONS).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    guard((args: { start: string; depth?: number; direction?: TraversalDirection }) =>
      asToolResult(store.graph.neighbourhood(args.start, args.depth, args.direction)),
    ),
  )
}
