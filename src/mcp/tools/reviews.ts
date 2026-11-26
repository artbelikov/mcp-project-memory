import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import {
  type CheckInput,
  type CloseReviewInput,
  COVERAGE_RESULTS,
  type CoverageInput,
  FINDING_SEVERITIES,
  type FindingInput,
  REFUTATION_VERDICTS,
  RESOLUTION_STATUSES,
  REVIEW_LENSES,
  REVIEW_PHASES,
  REVIEW_RISKS,
  type RefutationInput,
  type ResolutionInput,
  type ReviewListFilter,
} from '../../repositories/reviews.js'
import type { HarnessStore } from '../../store.js'
import {
  MAX_CHECK_COMMAND_LENGTH,
  MAX_CHECK_DIGEST_LENGTH,
  MAX_CHECK_NAME_LENGTH,
  MAX_CHECK_OUTPUT_LENGTH,
  MAX_COVERAGE_FILES_LENGTH,
  MAX_FINDING_CLAIM_LENGTH,
  MAX_FINDING_CLASS_KEY_LENGTH,
  MAX_FINDING_CLASS_SCAN_LENGTH,
  MAX_FINDING_EVIDENCE_LENGTH,
  MAX_FINDING_FAILURE_MODE_LENGTH,
  MAX_FINDING_RESOLUTION_LENGTH,
  MAX_FINDING_TITLE_LENGTH,
  MAX_REFUTATION_KILL_STRATEGY_LENGTH,
  MAX_REFUTATION_REASONING_LENGTH,
  MAX_REFUTATION_REPRO_LENGTH,
  MAX_REVIEW_HEAD_LENGTH,
  MAX_REVIEW_ORACLE_LENGTH,
  MAX_REVIEW_PATH_LENGTH,
  MAX_REVIEW_SUMMARY_LENGTH,
} from '../../util.js'
import { asToolResult, guard } from '../support.js'

const refSchema = z.string().describe('Review ref like CR1')
const lensSchema = z.enum(REVIEW_LENSES)
const severitySchema = z.enum(FINDING_SEVERITIES)

export function registerReviewTools(server: McpServer, store: HarnessStore): void {
  server.registerTool(
    'review_start',
    {
      title: 'Start or advance a code review',
      description:
        'Open the adversarial review gate for a task, or advance it to a new round after fixes. One review per task; rounds are capped at 3. Non-exempt reviews require the task to be in-progress, an oracle (the quoted acceptance criteria, defaults to the task spec) and a reviewer identity; medium/high risk also require freshContext:true. Returns the review row; use the code-review prompt for the finder brief. A new round is refused while candidates are unrefuted or findings are unresolved.',
      inputSchema: {
        taskId: z.string().describe('Task id to review'),
        baseRef: z
          .string()
          .optional()
          .describe(
            `Base branch/ref the diff is measured from; max ${MAX_REVIEW_HEAD_LENGTH} chars`,
          ),
        baseSha: z.string().optional().describe('Base commit SHA'),
        headSha: z.string().optional().describe('Head commit SHA under review'),
        diffHash: z.string().optional().describe('Stable fingerprint of the reviewed diff'),
        changedPaths: z
          .array(z.string())
          .optional()
          .describe(`Changed file paths; each max ${MAX_REVIEW_PATH_LENGTH} chars`),
        linesChanged: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Total added + removed lines, used to derive the risk tier'),
        risk: z
          .enum(REVIEW_RISKS)
          .optional()
          .describe('Risk tier; derived from changedPaths when omitted'),
        oracle: z
          .string()
          .optional()
          .describe(
            `Quoted acceptance criteria/invariants read before the code; max ${MAX_REVIEW_ORACLE_LENGTH} chars`,
          ),
        reviewer: z
          .string()
          .optional()
          .describe('Reviewer identity: subagent id, model, or session label'),
        freshContext: z
          .boolean()
          .optional()
          .describe(
            'True when the reviewer has no conversation history; required for medium/high risk',
          ),
      },
    },
    guard(
      (args: {
        taskId: string
        baseRef?: string
        baseSha?: string
        headSha?: string
        diffHash?: string
        changedPaths?: string[]
        linesChanged?: number
        risk?: (typeof REVIEW_RISKS)[number]
        oracle?: string
        reviewer?: string
        freshContext?: boolean
      }) => asToolResult(store.reviews.start(args)),
    ),
  )

  server.registerTool(
    'review_record_findings',
    {
      title: 'Record review candidates',
      description:
        'Append hunter candidates to an open review. Every candidate needs a lens, file:line, a one-sentence claim, a concrete failure mode (state + input → wrong outcome) and quoted evidence. Do not assign final severity, propose fixes, or filter plausibility here — the refutation pass does that. Duplicates are detected by fingerprint across rounds and returned in `duplicates` instead of reopening a closed finding. Only allowed in the hunting phase.',
      inputSchema: {
        ref: refSchema,
        findings: z
          .array(
            z.object({
              lens: lensSchema,
              title: z
                .string()
                .describe(`Short finding title; max ${MAX_FINDING_TITLE_LENGTH} chars`),
              file: z.string().describe('File path'),
              line: z.number().int().min(1).describe('1-based line number'),
              claim: z
                .string()
                .describe(`What is wrong, one sentence; max ${MAX_FINDING_CLAIM_LENGTH} chars`),
              failureMode: z
                .string()
                .describe(
                  `Concrete state + input → wrong outcome; max ${MAX_FINDING_FAILURE_MODE_LENGTH} chars`,
                ),
              evidence: z
                .string()
                .describe(
                  `Quoted code or command output; max ${MAX_FINDING_EVIDENCE_LENGTH} chars`,
                ),
              classKey: z
                .string()
                .optional()
                .describe(
                  `Bug class shared by other instances; max ${MAX_FINDING_CLASS_KEY_LENGTH} chars`,
                ),
              fingerprint: z
                .string()
                .optional()
                .describe('Stable dedupe key; computed from lens/file/class/title when omitted'),
              severityHint: severitySchema
                .optional()
                .describe('Initial severity hint, refined after refutation'),
              introducedByDiff: z
                .boolean()
                .optional()
                .describe('False when the defect already exists on the base branch'),
            }),
          )
          .min(1),
      },
    },
    guard((args: { ref: string; findings: FindingInput[] }) =>
      asToolResult(store.reviews.recordFindings(args.ref, args.findings)),
    ),
  )

  server.registerTool(
    'review_refute',
    {
      title: 'Refute review candidates',
      description:
        'Append skeptic verdicts. Each refuter sees the claim and evidence only, and must try to kill it: upstream guard, unreachable path, existing test, misread line, or the author’s best rebuttal. Framework/ORM claims must be settled by running code, not reading the library. A blocker/major needs two confirming refuters before it becomes confirmed; one confirmation leaves it plausible so the fix can still proceed. Refuting an all-clear is also valid. Only allowed before resolution.',
      inputSchema: {
        ref: refSchema,
        verdicts: z
          .array(
            z.object({
              findingId: z.number().int().positive(),
              refuter: z.string().describe('Skeptic identity; distinct refuters build a vote'),
              verdict: z.enum(REFUTATION_VERDICTS),
              reasoning: z
                .string()
                .describe(
                  `What you tried and why the verdict follows; max ${MAX_REFUTATION_REASONING_LENGTH} chars`,
                ),
              killStrategy: z
                .string()
                .describe(
                  `Which kill strategy applied (or why none did); max ${MAX_REFUTATION_KILL_STRATEGY_LENGTH} chars`,
                ),
              evidence: z
                .string()
                .describe(
                  `file:line, trace, test or command output; max ${MAX_FINDING_EVIDENCE_LENGTH} chars`,
                ),
              severity: severitySchema.optional().describe('Severity after refutation'),
              oneFactThatWouldOverturn: z
                .string()
                .optional()
                .describe('The single fact that would reverse this verdict'),
              repro: z
                .string()
                .optional()
                .describe(`Repro command or trace; max ${MAX_REFUTATION_REPRO_LENGTH} chars`),
            }),
          )
          .min(1),
      },
    },
    guard((args: { ref: string; verdicts: RefutationInput[] }) =>
      asToolResult(store.reviews.refute(args.ref, args.verdicts)),
    ),
  )

  server.registerTool(
    'review_resolve',
    {
      title: 'Resolve surviving findings',
      description:
        'Close confirmed/plausible findings. `fixed` requires evidence and, for blocker/major, a classScan proving the whole bug class was swept; fixed findings must be verified by a later re-review round before close. `waived` requires a decisionRef (record it with decision_append); `rejected` requires a reason and, for blocker/major, a decisionRef; `duplicate` requires duplicateOf; `pre-existing` requires the finding to be marked introducedByDiff:false plus evidence. Only allowed after refutation.',
      inputSchema: {
        ref: refSchema,
        resolutions: z
          .array(
            z.object({
              findingId: z.number().int().positive(),
              status: z.enum(RESOLUTION_STATUSES),
              reason: z
                .string()
                .describe(
                  `Why this resolution is correct; max ${MAX_FINDING_RESOLUTION_LENGTH} chars`,
                ),
              evidence: z
                .string()
                .optional()
                .describe(
                  `Fix proof (file:line or check name) or pre-existing proof; max ${MAX_FINDING_EVIDENCE_LENGTH} chars`,
                ),
              decisionRef: z
                .string()
                .optional()
                .describe('D-number authorizing a waiver or a high-severity rejection'),
              classScan: z
                .string()
                .optional()
                .describe(
                  `How every other instance of the class was found/cleared; max ${MAX_FINDING_CLASS_SCAN_LENGTH} chars`,
                ),
              duplicateOf: z.number().int().positive().optional().describe('Original finding id'),
            }),
          )
          .min(1),
      },
    },
    guard((args: { ref: string; resolutions: ResolutionInput[] }) =>
      asToolResult(store.reviews.resolve(args.ref, args.resolutions)),
    ),
  )

  server.registerTool(
    'review_check',
    {
      title: 'Record review checks',
      description:
        'Record executable evidence for the current review round: lint, typecheck, test, build, security or a custom gate. Store the exact command and exit code. review_close requires at least one check in the current round and the latest run of every named check to be green. Record red runs too — a later green run supersedes them.',
      inputSchema: {
        ref: refSchema,
        checks: z
          .array(
            z.object({
              name: z.string().describe(`Check name; max ${MAX_CHECK_NAME_LENGTH} chars`),
              command: z.string().describe(`Exact command; max ${MAX_CHECK_COMMAND_LENGTH} chars`),
              exitCode: z.number().int().describe('Process exit code; 0 means green'),
              outputDigest: z
                .string()
                .optional()
                .describe(`Hash of the full output; max ${MAX_CHECK_DIGEST_LENGTH} chars`),
              outputExcerpt: z
                .string()
                .optional()
                .describe(`Short tail of the output; max ${MAX_CHECK_OUTPUT_LENGTH} chars`),
            }),
          )
          .min(1),
      },
    },
    guard((args: { ref: string; checks: CheckInput[] }) =>
      asToolResult(store.reviews.recordChecks(args.ref, args.checks)),
    ),
  )

  server.registerTool(
    'review_coverage',
    {
      title: 'Record review coverage',
      description:
        'Record which files a lens actually examined and whether it came back clean or with findings. review_close requires a coverage row in the current round for every required lens: correctness for low risk, correctness + tests for medium, correctness + tests + security for high. Silence never implies coverage.',
      inputSchema: {
        ref: refSchema,
        coverage: z
          .array(
            z.object({
              lens: lensSchema,
              filesExamined: z
                .string()
                .describe(`Files/directories examined; max ${MAX_COVERAGE_FILES_LENGTH} chars`),
              result: z.enum(COVERAGE_RESULTS),
              evidence: z
                .string()
                .describe(`How coverage was established; max ${MAX_FINDING_EVIDENCE_LENGTH} chars`),
            }),
          )
          .min(1),
      },
    },
    guard((args: { ref: string; coverage: CoverageInput[] }) =>
      asToolResult(store.reviews.recordCoverage(args.ref, args.coverage)),
    ),
  )

  server.registerTool(
    'review_close',
    {
      title: 'Close the review gate',
      description:
        'Close the review. Omit verdict to verify: every candidate must be refuted or resolved, fixes must have a later re-review round, the current round needs a green check and required lens coverage, and the reviewed head must match. Pass verdict:"exempt" with a summary for a non-code task (no findings allowed; medium/high risk also needs a decisionRef), or verdict:"escalated" with a summary after the round cap; an escalated review does not satisfy task completion. A decisionRef is required to close an escalated review as exempt.',
      inputSchema: {
        ref: refSchema,
        verdict: z.enum(['exempt', 'escalated']).optional(),
        headSha: z
          .string()
          .optional()
          .describe(`Final reviewed commit SHA; max ${MAX_REVIEW_HEAD_LENGTH} chars`),
        diffHash: z.string().optional().describe('Final reviewed diff fingerprint'),
        summary: z
          .string()
          .optional()
          .describe(
            `Verdict summary, required for exempt/escalated; max ${MAX_REVIEW_SUMMARY_LENGTH} chars`,
          ),
        decisionRef: z
          .string()
          .optional()
          .describe('Decision that authorizes closing an escalated review as exempt'),
      },
    },
    guard((args: { ref: string } & CloseReviewInput) => {
      const { ref, ...input } = args
      return asToolResult(store.reviews.close(ref, input))
    }),
  )

  server.registerTool(
    'review_get',
    {
      title: 'Get a review',
      description:
        'Fetch one review in full: the review row, every finding with its refutations, checks, coverage and the current completion gate (canComplete + blockers). Each finding carries a stable `ref` like CR1#3.',
      inputSchema: { ref: refSchema },
      annotations: { readOnlyHint: true },
    },
    guard((args: { ref: string }) => asToolResult(store.reviews.detail(args.ref))),
  )

  server.registerTool(
    'review_list',
    {
      title: 'List reviews',
      description:
        'List reviews newest first, optionally filtered by task or phase. Use review_get for findings and gate detail.',
      inputSchema: {
        taskId: z.string().optional(),
        phase: z.enum(REVIEW_PHASES).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    guard((args: ReviewListFilter) => asToolResult({ reviews: store.reviews.list(args) })),
  )

  server.registerTool(
    'review_health',
    {
      title: 'Review gate health',
      description:
        'Hygiene report for the review gate: open/verified/escalated reviews, open and unrefuted findings, waivers without a decision, tasks done without a verified review, reviews stale for 7+ days, round-cap hits and current-round coverage gaps — with sample refs.',
      annotations: { readOnlyHint: true },
    },
    guard(() => asToolResult(store.reviews.health())),
  )
}
