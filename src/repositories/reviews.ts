import { createHash } from 'node:crypto'
import type { DatabaseSync, StatementSync } from 'node:sqlite'
import type { ReviewGateMode } from '../config.js'
import { withTransaction, withUniqueRetry } from '../db/database.js'
import { HarnessError, type HarnessErrorCode } from '../errors.js'
import {
  assertMaxLength,
  assertString,
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
  MAX_REVIEW_CHANGED_PATHS,
  MAX_REVIEW_HEAD_LENGTH,
  MAX_REVIEW_ORACLE_LENGTH,
  MAX_REVIEW_PATH_LENGTH,
  MAX_REVIEW_SUMMARY_LENGTH,
  nextNumberIn,
  nowIso,
  REVIEW_REF_PATTERN,
} from '../util.js'

export const REVIEW_PHASES = [
  'hunting',
  'refuting',
  'fixing',
  'verified',
  'waived',
  'escalated',
  'abandoned',
] as const
export type ReviewPhase = (typeof REVIEW_PHASES)[number]

export const REVIEW_RISKS = ['low', 'medium', 'high', 'exempt'] as const
export type ReviewRisk = (typeof REVIEW_RISKS)[number]

export const REVIEW_LENSES = [
  'correctness',
  'security',
  'data',
  'tests',
  'conventions',
  'blast-radius',
  'over-engineering',
  'spec',
] as const
export type ReviewLens = (typeof REVIEW_LENSES)[number]

export const FINDING_SEVERITIES = ['blocker', 'major', 'minor', 'nit'] as const
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number]

export const FINDING_STATUSES = [
  'candidate',
  'confirmed',
  'refuted',
  'plausible',
  'fixed',
  'waived',
  'rejected',
  'duplicate',
  'pre-existing',
] as const
export type FindingStatus = (typeof FINDING_STATUSES)[number]

export const REFUTATION_VERDICTS = ['confirmed', 'refuted', 'plausible'] as const
export type RefutationVerdict = (typeof REFUTATION_VERDICTS)[number]

export const COVERAGE_RESULTS = ['clean', 'findings'] as const
export type CoverageResult = (typeof COVERAGE_RESULTS)[number]

export const REVIEW_VERDICTS = ['verified', 'verified-with-waivers', 'exempt', 'escalated'] as const
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number]

export const RESOLUTION_STATUSES = [
  'fixed',
  'waived',
  'rejected',
  'duplicate',
  'pre-existing',
] as const
export type ResolutionStatus = (typeof RESOLUTION_STATUSES)[number]

export type Review = {
  ref: string
  taskId: string
  round: number
  phase: ReviewPhase
  risk: ReviewRisk
  baseRef: string | null
  baseSha: string | null
  headSha: string | null
  diffHash: string | null
  changedPaths: string[]
  oracle: string
  reviewer: string | null
  freshContext: boolean
  summary: string | null
  verdict: ReviewVerdict | null
  createdAt: string
  updatedAt: string
  closedAt: string | null
}

export type ReviewFinding = {
  id: number
  reviewRef: string
  round: number
  seq: number
  fingerprint: string
  classKey: string | null
  lens: ReviewLens
  severity: FindingSeverity
  status: FindingStatus
  title: string
  file: string
  line: number
  claim: string
  failureMode: string
  evidence: string
  introducedByDiff: boolean
  confidence: number
  refuter: string | null
  rebuttal: string | null
  votesFor: number
  votesAgainst: number
  oneFactThatWouldOverturn: string | null
  classScan: string | null
  resolution: string | null
  decisionRef: string | null
  fixedRound: number | null
  createdAt: string
  updatedAt: string
  closedAt: string | null
}

export type ReviewRefutation = {
  id: number
  reviewRef: string
  findingId: number
  round: number
  refuter: string
  verdict: RefutationVerdict
  reasoning: string
  killStrategy: string
  evidence: string
  severity: FindingSeverity | null
  oneFactThatWouldOverturn: string | null
  repro: string | null
  createdAt: string
}

export type ReviewCheck = {
  id: number
  reviewRef: string
  round: number
  name: string
  command: string
  exitCode: number
  outputDigest: string | null
  outputExcerpt: string | null
  createdAt: string
}

export type ReviewCoverage = {
  id: number
  reviewRef: string
  round: number
  lens: ReviewLens
  filesExamined: string
  result: CoverageResult
  evidence: string
  createdAt: string
  updatedAt: string
}

export type ReviewFindingDetail = ReviewFinding & {
  ref: string
  refutations: ReviewRefutation[]
}

export type ReviewGateBlocker = {
  code: HarnessErrorCode
  message: string
}

export type ReviewAssessment = {
  review: Review | null
  blockers: ReviewGateBlocker[]
}

export type ReviewDetail = {
  review: Review
  findings: ReviewFindingDetail[]
  checks: ReviewCheck[]
  coverage: ReviewCoverage[]
  gate: { canComplete: boolean; blockers: ReviewGateBlocker[] }
}

export type ReviewSummary = {
  ref: string
  round: number
  phase: ReviewPhase
  risk: ReviewRisk
  verdict: ReviewVerdict | null
  openFindings: number
  canComplete: boolean
}

export type ReviewOverview = {
  open: number
  verified: number
  escalated: number
  findingsOpen: number
  waivers: number
  doneWithoutReview: number
}

export type ReviewHealth = ReviewOverview & {
  staleReviews: number
  unrefutedFindings: number
  waiversWithoutDecision: number
  roundCapHits: number
  coverageGaps: number
  samples: { staleReviews: string[]; openFindings: string[]; coverageGaps: string[] }
}

export type StartReviewInput = {
  taskId: string
  baseRef?: string
  baseSha?: string
  headSha?: string
  diffHash?: string
  changedPaths?: string[]
  linesChanged?: number
  risk?: ReviewRisk
  oracle?: string
  reviewer?: string
  freshContext?: boolean
}

export type FindingInput = {
  lens: ReviewLens
  title: string
  file: string
  line: number
  claim: string
  failureMode: string
  evidence: string
  classKey?: string
  fingerprint?: string
  severityHint?: FindingSeverity
  introducedByDiff?: boolean
}

export type RefutationInput = {
  findingId: number
  refuter: string
  verdict: RefutationVerdict
  reasoning: string
  killStrategy: string
  evidence: string
  severity?: FindingSeverity
  oneFactThatWouldOverturn?: string
  repro?: string
}

export type ResolutionInput = {
  findingId: number
  status: ResolutionStatus
  reason: string
  evidence?: string
  decisionRef?: string
  classScan?: string
  duplicateOf?: number
}

export type CheckInput = {
  name: string
  command: string
  exitCode: number
  outputDigest?: string
  outputExcerpt?: string
}

export type CoverageInput = {
  lens: ReviewLens
  filesExamined: string
  result: CoverageResult
  evidence: string
}

export type CloseReviewInput = {
  verdict?: 'exempt' | 'escalated'
  headSha?: string
  diffHash?: string
  summary?: string
  decisionRef?: string
}

export type ReviewListFilter = {
  taskId?: string
  phase?: ReviewPhase
  limit?: number
}

type ReviewRow = {
  id: number
  ref: string
  task_id: string
  round: number
  phase: string
  risk: string
  base_ref: string | null
  base_sha: string | null
  head_sha: string | null
  diff_hash: string | null
  changed_paths: string
  oracle: string
  reviewer: string | null
  fresh_context: number
  summary: string | null
  verdict: string | null
  created_at: string
  updated_at: string
  closed_at: string | null
}

type FindingRow = {
  id: number
  review_ref: string
  round: number
  seq: number
  fingerprint: string
  class_key: string | null
  lens: string
  severity: string
  status: string
  title: string
  file: string
  line: number
  claim: string
  failure_mode: string
  evidence: string
  introduced_by_diff: number
  confidence: number
  refuter: string | null
  rebuttal: string | null
  votes_for: number
  votes_against: number
  one_fact_that_would_overturn: string | null
  class_scan: string | null
  resolution: string | null
  decision_ref: string | null
  fixed_round: number | null
  created_at: string
  updated_at: string
  closed_at: string | null
}

type RefutationRow = {
  id: number
  review_ref: string
  finding_id: number
  round: number
  refuter: string
  verdict: string
  reasoning: string
  kill_strategy: string
  evidence: string
  severity: string | null
  one_fact_that_would_overturn: string | null
  repro: string | null
  created_at: string
}

type CheckRow = {
  id: number
  review_ref: string
  round: number
  name: string
  command: string
  exit_code: number
  output_digest: string | null
  output_excerpt: string | null
  created_at: string
}

type CoverageRow = {
  id: number
  review_ref: string
  round: number
  lens: string
  files_examined: string
  result: string
  evidence: string
  created_at: string
  updated_at: string
}

type TaskRow = { id: string; title: string; status: string; spec: string }

const MAX_REVIEW_ROUNDS = 3
const STALE_REVIEW_DAYS = 7
const HIGH_RISK_PATH =
  /(^|\/)(auth|authn|authz|security|crypto|secret|billing|payments?|migrations?|schema|infra|deploy|deployment|ci|\.github|docker)(\/|\.|$)/i
const HIGH_RISK_FILE =
  /^(Dockerfile|docker-compose[^/]*|package\.json|pnpm-lock\.yaml|package-lock\.json)$/i
const LOW_RISK_PATH = /\.(md|mdx|txt|rst)$/i

export class ReviewsRepository {
  private readonly selectByRef: StatementSync
  private readonly selectByTask: StatementSync
  private readonly selectAll: StatementSync
  private readonly insertReview: StatementSync
  private readonly updateReview: StatementSync
  private readonly selectFindings: StatementSync
  private readonly selectFinding: StatementSync
  private readonly insertFinding: StatementSync
  private readonly updateFinding: StatementSync
  private readonly selectRefutationsByFinding: StatementSync
  private readonly upsertRefutation: StatementSync
  private readonly selectChecks: StatementSync
  private readonly insertCheck: StatementSync
  private readonly selectCoverage: StatementSync
  private readonly upsertCoverage: StatementSync
  private readonly selectTask: StatementSync
  private readonly touchReviewStmt: StatementSync

  constructor(
    private readonly db: DatabaseSync,
    private readonly gateMode: ReviewGateMode,
  ) {
    this.selectByRef = db.prepare('SELECT * FROM reviews WHERE ref = ?')
    this.selectByTask = db.prepare('SELECT * FROM reviews WHERE task_id = ?')
    this.selectAll = db.prepare('SELECT * FROM reviews ORDER BY id ASC')
    this.insertReview = db.prepare(
      `INSERT INTO reviews (ref, task_id, round, phase, risk, base_ref, base_sha, head_sha, diff_hash, changed_paths, oracle, reviewer, fresh_context, summary, verdict, created_at, updated_at, closed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    this.updateReview = db.prepare(
      `UPDATE reviews SET round = ?, phase = ?, risk = ?, base_ref = ?, base_sha = ?, head_sha = ?, diff_hash = ?, changed_paths = ?, oracle = ?, reviewer = ?, fresh_context = ?, summary = ?, verdict = ?, updated_at = ?, closed_at = ?
       WHERE ref = ?`,
    )
    this.selectFindings = db.prepare(
      'SELECT * FROM review_findings WHERE review_ref = ? ORDER BY seq ASC',
    )
    this.selectFinding = db.prepare('SELECT * FROM review_findings WHERE id = ?')
    this.insertFinding = db.prepare(
      `INSERT INTO review_findings (review_ref, round, seq, fingerprint, class_key, lens, severity, status, title, file, line, claim, failure_mode, evidence, introduced_by_diff, confidence, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'candidate', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    this.updateFinding = db.prepare(
      `UPDATE review_findings SET severity = ?, status = ?, refuter = ?, rebuttal = ?, votes_for = ?, votes_against = ?, one_fact_that_would_overturn = ?, confidence = ?, class_scan = ?, resolution = ?, decision_ref = ?, fixed_round = ?, updated_at = ?, closed_at = ?
       WHERE id = ?`,
    )
    this.selectRefutationsByFinding = db.prepare(
      'SELECT * FROM review_refutations WHERE finding_id = ? AND round = ? ORDER BY id ASC',
    )
    this.upsertRefutation = db.prepare(
      `INSERT INTO review_refutations (review_ref, finding_id, round, refuter, verdict, reasoning, kill_strategy, evidence, severity, one_fact_that_would_overturn, repro, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(finding_id, refuter, round) DO UPDATE SET
         verdict = excluded.verdict,
         reasoning = excluded.reasoning,
         kill_strategy = excluded.kill_strategy,
         evidence = excluded.evidence,
         severity = excluded.severity,
         one_fact_that_would_overturn = excluded.one_fact_that_would_overturn,
         repro = excluded.repro,
         created_at = excluded.created_at`,
    )
    this.selectChecks = db.prepare(
      'SELECT * FROM review_checks WHERE review_ref = ? ORDER BY id ASC',
    )
    this.insertCheck = db.prepare(
      `INSERT INTO review_checks (review_ref, round, name, command, exit_code, output_digest, output_excerpt, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    this.selectCoverage = db.prepare(
      'SELECT * FROM review_coverage WHERE review_ref = ? ORDER BY id ASC',
    )
    this.upsertCoverage = db.prepare(
      `INSERT INTO review_coverage (review_ref, round, lens, files_examined, result, evidence, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(review_ref, round, lens) DO UPDATE SET
         files_examined = excluded.files_examined,
         result = excluded.result,
         evidence = excluded.evidence,
         updated_at = excluded.updated_at`,
    )
    this.selectTask = db.prepare('SELECT id, title, status, spec FROM tasks WHERE id = ?')
    this.touchReviewStmt = db.prepare('UPDATE reviews SET updated_at = ? WHERE ref = ?')
  }

  start(input: StartReviewInput): Review {
    const task = this.task(input.taskId)
    if (task.status === 'done' || task.status === 'cancelled') {
      throw new HarnessError(
        'conflict',
        `task "${input.taskId}" is ${task.status}; reopen it before starting a review`,
      )
    }
    const existing = this.findByTask(input.taskId)
    const risk =
      input.risk ??
      deriveRisk(input.changedPaths ?? existing?.changedPaths ?? [], input.linesChanged ?? 0)
    const oracle = (input.oracle ?? existing?.oracle ?? task.spec).trim()
    const reviewer = optional(input.reviewer, 'reviewer', 200) ?? existing?.reviewer ?? null
    const freshContext = input.freshContext ?? existing?.freshContext ?? false
    if (risk !== 'exempt') {
      if (task.status !== 'in-progress') {
        throw new HarnessError(
          'invalid',
          `task "${input.taskId}" must be in-progress before review_start; it is ${task.status}`,
        )
      }
      if (oracle.length === 0) {
        throw new HarnessError(
          'invalid',
          'review_start requires an oracle: quote the task acceptance criteria in spec or pass oracle',
        )
      }
      assertMaxLength(oracle, 'oracle', MAX_REVIEW_ORACLE_LENGTH)
      if (reviewer === null) {
        throw new HarnessError(
          'invalid',
          'review_start requires a reviewer identity so the review can be audited',
        )
      }
      if ((risk === 'medium' || risk === 'high') && !freshContext) {
        throw new HarnessError(
          'invalid',
          `risk "${risk}" requires a fresh-context reviewer; pass freshContext: true`,
        )
      }
    }
    const changedPaths = input.changedPaths ?? existing?.changedPaths ?? []
    validatePaths(changedPaths)
    const baseRef = optional(input.baseRef, 'baseRef', MAX_REVIEW_HEAD_LENGTH)
    const baseSha = optional(input.baseSha, 'baseSha', MAX_REVIEW_HEAD_LENGTH)
    const headSha = optional(input.headSha, 'headSha', MAX_REVIEW_HEAD_LENGTH)
    const diffHash = optional(input.diffHash, 'diffHash', MAX_REVIEW_HEAD_LENGTH)
    const at = nowIso()

    if (existing === null) {
      return withUniqueRetry(() =>
        withTransaction(this.db, () => {
          const ref = this.allocateRef()
          this.insertReview.run(
            ref,
            input.taskId,
            1,
            'hunting',
            risk,
            baseRef,
            baseSha,
            headSha,
            diffHash,
            JSON.stringify(changedPaths),
            oracle,
            reviewer,
            freshContext ? 1 : 0,
            null,
            null,
            at,
            at,
            null,
          )
          return this.get(ref)
        }),
      )
    }

    if (isFinalPhase(existing.phase)) {
      if (existing.phase === 'escalated') {
        throw new HarnessError(
          'review-open',
          `${existing.ref} was escalated; record a decision and close it as exempt, or split the task`,
        )
      }
      if (existing.phase === 'abandoned') {
        throw new HarnessError('conflict', `${existing.ref} was abandoned with its task`)
      }
    }

    if (existing.phase === 'hunting' || existing.phase === 'refuting') {
      const candidates = this.findings(existing.ref).filter(
        (finding) => finding.status === 'candidate',
      )
      if (candidates.length > 0) {
        throw new HarnessError(
          'review-unrefuted',
          `${existing.ref} has ${candidates.length} unrefuted candidate(s); refute them before starting a new round`,
        )
      }
    }

    const unresolved = this.findings(existing.ref).filter((finding) =>
      ['candidate', 'confirmed', 'plausible'].includes(finding.status),
    )
    if (unresolved.length > 0) {
      throw new HarnessError(
        'review-open',
        `${existing.ref} still has ${unresolved.length} unresolved finding(s); fix, waive or reject them before a new round`,
      )
    }

    if (existing.phase === 'hunting' && !this.hasRoundActivity(existing.ref, existing.round)) {
      this.updateReview.run(
        existing.round,
        'hunting',
        risk,
        baseRef ?? existing.baseRef,
        baseSha ?? existing.baseSha,
        headSha ?? existing.headSha,
        diffHash ?? existing.diffHash,
        JSON.stringify(changedPaths),
        oracle,
        reviewer,
        freshContext ? 1 : 0,
        null,
        null,
        at,
        null,
        existing.ref,
      )
      return this.get(existing.ref)
    }

    const round = existing.round + 1
    if (round > MAX_REVIEW_ROUNDS) {
      throw new HarnessError(
        'review-round-cap',
        `${existing.ref} reached ${MAX_REVIEW_ROUNDS} rounds; escalate with a decision or split the task instead of re-reviewing again`,
      )
    }

    this.updateReview.run(
      round,
      'hunting',
      risk,
      baseRef ?? existing.baseRef,
      baseSha ?? existing.baseSha,
      headSha ?? existing.headSha,
      diffHash ?? existing.diffHash,
      JSON.stringify(changedPaths),
      oracle,
      reviewer,
      freshContext ? 1 : 0,
      null,
      null,
      at,
      null,
      existing.ref,
    )
    return this.get(existing.ref)
  }

  reopen(taskId: string): Review | null {
    const review = this.findByTask(taskId)
    if (review === null) return null
    if (review.phase !== 'verified' && review.phase !== 'waived') return review
    const at = nowIso()
    if (review.round >= MAX_REVIEW_ROUNDS) {
      this.updateReview.run(
        review.round,
        'escalated',
        review.risk,
        review.baseRef,
        review.baseSha,
        review.headSha,
        review.diffHash,
        JSON.stringify(review.changedPaths),
        review.oracle,
        review.reviewer,
        review.freshContext ? 1 : 0,
        'task reopened after the review-round cap; split it or record a decision',
        'escalated',
        at,
        at,
        review.ref,
      )
      return this.get(review.ref)
    }
    this.updateReview.run(
      review.round + 1,
      'hunting',
      review.risk,
      review.baseRef,
      review.baseSha,
      review.headSha,
      review.diffHash,
      JSON.stringify(review.changedPaths),
      review.oracle,
      review.reviewer,
      review.freshContext ? 1 : 0,
      null,
      null,
      at,
      null,
      review.ref,
    )
    return this.get(review.ref)
  }

  recordFindings(
    ref: string,
    inputs: readonly FindingInput[],
  ): {
    reviewRef: string
    recorded: ReviewFindingDetail[]
    duplicates: { fingerprint: string; findingId: number; status: FindingStatus }[]
  } {
    const review = this.get(ref)
    this.assertPhase(review, ['hunting'], 'record findings')
    if (inputs.length === 0) {
      throw new HarnessError('invalid', 'record at least one finding')
    }
    return withTransaction(this.db, () => {
      const existingByFingerprint = new Map(
        this.findings(ref).map((finding) => [finding.fingerprint, finding] as const),
      )
      const recorded: ReviewFindingDetail[] = []
      const duplicates: { fingerprint: string; findingId: number; status: FindingStatus }[] = []
      let seq = this.findings(ref).reduce((max, finding) => Math.max(max, finding.seq), 0)
      const at = nowIso()
      for (const input of inputs) {
        const finding = validateFinding(input)
        const fingerprint = input.fingerprint ?? fingerprintOf(finding)
        assertMaxLength(fingerprint, 'fingerprint', 64)
        const existing = existingByFingerprint.get(fingerprint)
        if (existing !== undefined) {
          duplicates.push({
            fingerprint,
            findingId: existing.id,
            status: existing.status,
          })
          continue
        }
        seq += 1
        this.insertFinding.run(
          ref,
          review.round,
          seq,
          fingerprint,
          finding.classKey ?? null,
          finding.lens,
          finding.severityHint ?? 'minor',
          finding.title,
          finding.file,
          finding.line,
          finding.claim,
          finding.failureMode,
          finding.evidence,
          finding.introducedByDiff === false ? 0 : 1,
          0.5,
          at,
          at,
        )
        const row = this.db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }
        const created = this.finding(row.id)
        existingByFingerprint.set(fingerprint, created)
        recorded.push(this.findingDetail(created))
      }
      this.touchReviewStmt.run(nowIso(), ref)
      return { reviewRef: ref, recorded, duplicates }
    })
  }

  refute(
    ref: string,
    inputs: readonly RefutationInput[],
  ): { reviewRef: string; findings: ReviewFindingDetail[] } {
    const review = this.get(ref)
    this.assertPhase(review, ['hunting', 'refuting'], 'refute findings')
    if (inputs.length === 0) {
      throw new HarnessError('invalid', 'record at least one refutation')
    }
    return withTransaction(this.db, () => {
      const touched = new Set<number>()
      const at = nowIso()
      for (const input of inputs) {
        const finding = this.finding(input.findingId)
        if (finding.reviewRef !== ref) {
          throw new HarnessError(
            'not-found',
            `finding ${input.findingId} does not belong to ${ref}`,
          )
        }
        if (!['candidate', 'confirmed', 'plausible'].includes(finding.status)) {
          throw new HarnessError(
            'conflict',
            `finding ${finding.seq} is already ${finding.status}; refutation is closed`,
          )
        }
        const refuter = assertString(input.refuter, 'refuter', 200)
        const reasoning = assertString(
          input.reasoning,
          'reasoning',
          MAX_REFUTATION_REASONING_LENGTH,
        )
        const killStrategy = assertString(
          input.killStrategy,
          'killStrategy',
          MAX_REFUTATION_KILL_STRATEGY_LENGTH,
        )
        const evidence = assertString(input.evidence, 'evidence', MAX_FINDING_EVIDENCE_LENGTH)
        const severity = input.severity ?? finding.severity
        const oneFact = optional(
          input.oneFactThatWouldOverturn,
          'oneFactThatWouldOverturn',
          MAX_FINDING_CLAIM_LENGTH,
        )
        const repro = optional(input.repro, 'repro', MAX_REFUTATION_REPRO_LENGTH)
        this.upsertRefutation.run(
          ref,
          finding.id,
          finding.round,
          refuter,
          input.verdict,
          reasoning,
          killStrategy,
          evidence,
          severity,
          oneFact,
          repro,
          at,
        )
        this.recomputeFinding(finding.id)
        touched.add(finding.id)
      }
      if (review.phase === 'hunting') {
        this.updateReview.run(
          review.round,
          'refuting',
          review.risk,
          review.baseRef,
          review.baseSha,
          review.headSha,
          review.diffHash,
          JSON.stringify(review.changedPaths),
          review.oracle,
          review.reviewer,
          review.freshContext ? 1 : 0,
          review.summary,
          review.verdict,
          nowIso(),
          review.closedAt,
          review.ref,
        )
      }
      this.touchReviewStmt.run(nowIso(), ref)
      return {
        reviewRef: ref,
        findings: [...touched].map((id) => this.findingDetail(this.finding(id))),
      }
    })
  }

  resolve(
    ref: string,
    inputs: readonly ResolutionInput[],
  ): { reviewRef: string; findings: ReviewFindingDetail[] } {
    const review = this.get(ref)
    this.assertPhase(review, ['refuting', 'fixing'], 'resolve findings')
    if (inputs.length === 0) {
      throw new HarnessError('invalid', 'record at least one resolution')
    }
    return withTransaction(this.db, () => {
      const touched = new Set<number>()
      const at = nowIso()
      for (const input of inputs) {
        const finding = this.finding(input.findingId)
        if (finding.reviewRef !== ref) {
          throw new HarnessError(
            'not-found',
            `finding ${input.findingId} does not belong to ${ref}`,
          )
        }
        if (!['confirmed', 'plausible'].includes(finding.status)) {
          throw new HarnessError(
            'conflict',
            `finding ${finding.seq} is ${finding.status}; only confirmed or plausible findings can be resolved`,
          )
        }
        const reason = assertString(input.reason, 'reason', MAX_FINDING_RESOLUTION_LENGTH)
        let resolution = reason
        let decisionRef: string | null = null
        let classScan: string | null = finding.classScan
        let fixedRound: number | null = finding.fixedRound
        if (input.status === 'fixed') {
          const evidence = assertString(input.evidence, 'evidence', MAX_FINDING_EVIDENCE_LENGTH)
          resolution = `${reason} | ${evidence}`
          fixedRound = review.round
          if (isHighSeverity(finding.severity)) {
            classScan = assertString(input.classScan, 'classScan', MAX_FINDING_CLASS_SCAN_LENGTH)
          } else {
            classScan =
              optional(input.classScan, 'classScan', MAX_FINDING_CLASS_SCAN_LENGTH) ?? classScan
          }
        } else if (input.status === 'waived') {
          decisionRef = requireDecision(this.db, input.decisionRef)
          resolution = `${reason} | decision:${decisionRef}`
        } else if (input.status === 'rejected') {
          if (isHighSeverity(finding.severity)) {
            decisionRef = requireDecision(this.db, input.decisionRef)
          }
        } else if (input.status === 'duplicate') {
          if (input.duplicateOf === undefined) {
            throw new HarnessError('invalid', 'duplicate resolutions require duplicateOf')
          }
          const original = this.finding(input.duplicateOf)
          if (original.reviewRef !== ref) {
            throw new HarnessError(
              'invalid',
              `duplicateOf finding ${input.duplicateOf} is not in ${ref}`,
            )
          }
          resolution = `duplicate of #${original.seq}: ${reason}`
        } else if (input.status === 'pre-existing') {
          if (finding.introducedByDiff) {
            throw new HarnessError(
              'invalid',
              `finding ${finding.seq} was marked as introduced by this diff; pre-existing is not a valid resolution`,
            )
          }
          const evidence = assertString(input.evidence, 'evidence', MAX_FINDING_EVIDENCE_LENGTH)
          resolution = `${reason} | ${evidence}`
        }
        this.updateFinding.run(
          finding.severity,
          input.status,
          finding.refuter,
          finding.rebuttal,
          finding.votesFor,
          finding.votesAgainst,
          finding.oneFactThatWouldOverturn,
          finding.confidence,
          classScan,
          resolution,
          decisionRef,
          fixedRound,
          at,
          at,
          finding.id,
        )
        touched.add(finding.id)
      }
      if (review.phase === 'refuting') {
        this.updateReview.run(
          review.round,
          'fixing',
          review.risk,
          review.baseRef,
          review.baseSha,
          review.headSha,
          review.diffHash,
          JSON.stringify(review.changedPaths),
          review.oracle,
          review.reviewer,
          review.freshContext ? 1 : 0,
          review.summary,
          review.verdict,
          nowIso(),
          review.closedAt,
          review.ref,
        )
      }
      this.touchReviewStmt.run(nowIso(), ref)
      return {
        reviewRef: ref,
        findings: [...touched].map((id) => this.findingDetail(this.finding(id))),
      }
    })
  }

  recordChecks(ref: string, inputs: readonly CheckInput[]): ReviewCheck[] {
    const review = this.get(ref)
    this.assertOpen(review, 'record checks')
    if (inputs.length === 0) {
      throw new HarnessError('invalid', 'record at least one check')
    }
    return withTransaction(this.db, () => {
      const at = nowIso()
      const recorded: ReviewCheck[] = []
      for (const input of inputs) {
        const name = assertString(input.name, 'check name', MAX_CHECK_NAME_LENGTH)
        const command = assertString(input.command, 'check command', MAX_CHECK_COMMAND_LENGTH)
        if (!Number.isSafeInteger(input.exitCode)) {
          throw new HarnessError('invalid', 'check exitCode must be an integer')
        }
        const outputDigest = optional(input.outputDigest, 'outputDigest', MAX_CHECK_DIGEST_LENGTH)
        const outputExcerpt = optional(
          input.outputExcerpt,
          'outputExcerpt',
          MAX_CHECK_OUTPUT_LENGTH,
        )
        this.insertCheck.run(
          ref,
          review.round,
          name,
          command,
          input.exitCode,
          outputDigest,
          outputExcerpt,
          at,
        )
        const row = this.db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }
        recorded.push(this.check(row.id))
      }
      this.touchReviewStmt.run(nowIso(), ref)
      return recorded
    })
  }

  recordCoverage(ref: string, inputs: readonly CoverageInput[]): ReviewCoverage[] {
    const review = this.get(ref)
    this.assertOpen(review, 'record coverage')
    if (inputs.length === 0) {
      throw new HarnessError('invalid', 'record at least one coverage row')
    }
    return withTransaction(this.db, () => {
      const at = nowIso()
      const recorded: ReviewCoverage[] = []
      for (const input of inputs) {
        const filesExamined = assertString(
          input.filesExamined,
          'filesExamined',
          MAX_COVERAGE_FILES_LENGTH,
        )
        const evidence = assertString(
          input.evidence,
          'coverage evidence',
          MAX_FINDING_EVIDENCE_LENGTH,
        )
        this.upsertCoverage.run(
          ref,
          review.round,
          input.lens,
          filesExamined,
          input.result,
          evidence,
          at,
          at,
        )
        const row = this.db
          .prepare('SELECT * FROM review_coverage WHERE review_ref = ? AND round = ? AND lens = ?')
          .get(ref, review.round, input.lens) as unknown as CoverageRow
        recorded.push(toCoverage(row))
      }
      this.touchReviewStmt.run(nowIso(), ref)
      return recorded
    })
  }

  close(ref: string, input: CloseReviewInput = {}): ReviewDetail {
    const review = this.get(ref)
    const at = nowIso()
    if (review.phase === 'escalated') {
      if (input.verdict !== 'exempt') {
        throw new HarnessError(
          'review-open',
          `${ref} is escalated; a decision can close it as exempt, or split the task`,
        )
      }
      const decisionRef = requireDecision(this.db, input.decisionRef)
      this.updateReview.run(
        review.round,
        'waived',
        review.risk,
        review.baseRef,
        review.baseSha,
        input.headSha ?? review.headSha,
        input.diffHash ?? review.diffHash,
        JSON.stringify(review.changedPaths),
        review.oracle,
        review.reviewer,
        review.freshContext ? 1 : 0,
        optional(input.summary, 'summary', MAX_REVIEW_SUMMARY_LENGTH) ??
          `Escalation waived by ${decisionRef}`,
        'exempt',
        at,
        at,
        ref,
      )
      return this.detail(ref)
    }
    if (isFinalPhase(review.phase)) {
      throw new HarnessError('conflict', `${ref} is already ${review.phase}`)
    }

    if (input.verdict === 'exempt') {
      const findings = this.findings(ref)
      if (findings.length > 0) {
        throw new HarnessError(
          'invalid',
          'an exempt review cannot carry findings; record the reason as an exemption instead',
        )
      }
      const requiresDecision = review.risk === 'medium' || review.risk === 'high'
      const decisionRef = requiresDecision ? requireDecision(this.db, input.decisionRef) : null
      const reason = assertString(input.summary, 'summary', MAX_REVIEW_SUMMARY_LENGTH)
      const summary = decisionRef === null ? reason : `${reason} | decision:${decisionRef}`
      this.updateReview.run(
        review.round,
        'waived',
        review.risk,
        review.baseRef,
        review.baseSha,
        input.headSha ?? review.headSha,
        input.diffHash ?? review.diffHash,
        JSON.stringify(review.changedPaths),
        review.oracle,
        review.reviewer,
        review.freshContext ? 1 : 0,
        summary,
        'exempt',
        at,
        at,
        ref,
      )
      return this.detail(ref)
    }

    if (input.verdict === 'escalated') {
      const summary = assertString(input.summary, 'summary', MAX_REVIEW_SUMMARY_LENGTH)
      this.updateReview.run(
        review.round,
        'escalated',
        review.risk,
        review.baseRef,
        review.baseSha,
        input.headSha ?? review.headSha,
        input.diffHash ?? review.diffHash,
        JSON.stringify(review.changedPaths),
        review.oracle,
        review.reviewer,
        review.freshContext ? 1 : 0,
        summary,
        'escalated',
        at,
        at,
        ref,
      )
      return this.detail(ref)
    }

    if (review.risk === 'exempt') {
      throw new HarnessError(
        'invalid',
        'exempt reviews must close with verdict "exempt" and a summary',
      )
    }
    if (review.oracle.trim().length === 0) {
      throw new HarnessError('invalid', `${ref} has no oracle; restart the review with one`)
    }
    const headSha = input.headSha ?? review.headSha
    if (
      review.headSha !== null &&
      input.headSha !== undefined &&
      input.headSha !== review.headSha
    ) {
      throw new HarnessError(
        'review-stale',
        `${ref} was reviewed at ${review.headSha}; close reports ${input.headSha} — restart the review on the new head`,
      )
    }
    if (headSha === null) {
      throw new HarnessError(
        'review-stale',
        `${ref} has no reviewed head; pass headSha to review_start or review_close`,
      )
    }
    const diffHash = input.diffHash ?? review.diffHash
    if (
      review.diffHash !== null &&
      input.diffHash !== undefined &&
      input.diffHash !== review.diffHash
    ) {
      throw new HarnessError(
        'review-stale',
        `${ref} was reviewed with diff ${review.diffHash}; close reports ${input.diffHash}`,
      )
    }

    const findings = this.findings(ref)
    const open = findings.filter((finding) =>
      ['candidate', 'confirmed', 'plausible'].includes(finding.status),
    )
    if (open.length > 0) {
      const sample = open
        .slice(0, 5)
        .map((finding) => `${ref}#${finding.seq} (${finding.severity}, ${finding.status})`)
        .join(', ')
      throw new HarnessError(
        'review-open',
        `${ref} has ${open.length} open finding(s): ${sample}. Fix, waive or reject each before closing`,
      )
    }
    const fixedRound = findings.reduce(
      (max, finding) => (finding.fixedRound === null ? max : Math.max(max, finding.fixedRound)),
      0,
    )
    if (fixedRound >= review.round) {
      throw new HarnessError(
        'review-open',
        `${ref} has fixes recorded in round ${fixedRound}; start a re-review round and verify the delta before closing`,
      )
    }

    const checks = this.checks(ref).filter((check) => check.round === review.round)
    if (checks.length === 0) {
      throw new HarnessError(
        'review-checks',
        `${ref} has no checks in round ${review.round}; run the project gates and record them with review_check`,
      )
    }
    const latestByName = new Map<string, ReviewCheck>()
    for (const check of checks) latestByName.set(check.name, check)
    const failed = [...latestByName.values()].filter((check) => check.exitCode !== 0)
    if (failed.length > 0) {
      throw new HarnessError(
        'review-checks',
        `${ref} has failing checks: ${failed.map((check) => `${check.name} (${check.exitCode})`).join(', ')}`,
      )
    }

    const required = requiredLenses(review.risk)
    const covered = new Set(
      this.coverage(ref)
        .filter((row) => row.round === review.round)
        .map((row) => row.lens),
    )
    const missing = required.filter((lens) => !covered.has(lens))
    if (missing.length > 0) {
      throw new HarnessError(
        'review-lens-missing',
        `${ref} round ${review.round} has no coverage for ${missing.join(', ')} (required for risk "${review.risk}")`,
      )
    }

    const verdict: ReviewVerdict = findings.some((finding) => finding.status === 'waived')
      ? 'verified-with-waivers'
      : 'verified'
    this.updateReview.run(
      review.round,
      'verified',
      review.risk,
      review.baseRef,
      review.baseSha,
      headSha,
      diffHash,
      JSON.stringify(review.changedPaths),
      review.oracle,
      review.reviewer,
      review.freshContext ? 1 : 0,
      optional(input.summary, 'summary', MAX_REVIEW_SUMMARY_LENGTH) ?? review.summary,
      verdict,
      at,
      at,
      ref,
    )
    return this.detail(ref)
  }

  assess(
    taskId: string,
    headSha?: string,
    requireHead = false,
    diffHash?: string,
  ): ReviewAssessment {
    const review = this.findByTask(taskId)
    if (review === null) {
      return {
        review: null,
        blockers: [
          {
            code: 'review-required',
            message: `task "${taskId}" cannot be marked done — no code review on record. Call review_start(taskId:"${taskId}"), run the brief, then review_close.`,
          },
        ],
      }
    }
    const blockers: ReviewGateBlocker[] = []
    if (review.phase === 'verified') {
      if (review.verdict !== 'verified' && review.verdict !== 'verified-with-waivers') {
        blockers.push({
          code: 'review-open',
          message: `${review.ref} is verified without a verified verdict`,
        })
      }
      if (review.headSha === null) {
        blockers.push({
          code: 'review-stale',
          message: `${review.ref} has no recorded reviewed head; close the review with headSha`,
        })
      } else if (headSha !== undefined && review.headSha !== headSha) {
        blockers.push({
          code: 'review-stale',
          message: `${review.ref} was verified at ${review.headSha}, but completion reports ${headSha}. Re-review the delta.`,
        })
      } else if (requireHead && headSha === undefined) {
        blockers.push({
          code: 'review-stale',
          message: `task "${taskId}" cannot be marked done without headSha; ${review.ref} was verified at ${review.headSha}`,
        })
      }
      if (review.diffHash !== null) {
        if (diffHash !== undefined && diffHash !== review.diffHash) {
          blockers.push({
            code: 'review-stale',
            message: `${review.ref} was verified with diff ${review.diffHash}, but completion reports ${diffHash}. Re-review the delta.`,
          })
        } else if (requireHead && diffHash === undefined) {
          blockers.push({
            code: 'review-stale',
            message: `task "${taskId}" cannot be marked done without diffHash; ${review.ref} was verified with ${review.diffHash}`,
          })
        }
      }
    } else if (review.phase === 'waived' && review.verdict === 'exempt') {
      blockers.push(...[])
    } else if (review.phase === 'escalated') {
      blockers.push({
        code: 'review-open',
        message: `${review.ref} is escalated${review.summary === null ? '' : `: ${review.summary}`}. Record a decision and close it as exempt, or split the task.`,
      })
    } else if (review.phase === 'abandoned') {
      blockers.push({
        code: 'review-open',
        message: `${review.ref} was abandoned with its task`,
      })
    } else {
      const open = this.findings(review.ref).filter((finding) =>
        ['candidate', 'confirmed', 'plausible'].includes(finding.status),
      )
      const sample =
        open.length === 0
          ? ''
          : `: ${open
              .slice(0, 5)
              .map(
                (finding) =>
                  `${review.ref}#${finding.seq} (${finding.severity}, ${finding.status})`,
              )
              .join(', ')}`
      blockers.push({
        code: 'review-open',
        message: `${review.ref} is in phase "${review.phase}" with ${open.length} open finding(s)${sample}. Close the review first.`,
      })
    }
    return { review, blockers }
  }

  assertCanComplete(taskId: string, headSha?: string, diffHash?: string): ReviewAssessment {
    const assessment = this.assess(taskId, headSha, true, diffHash)
    if (this.gateMode !== 'enforce') return assessment
    const first = assessment.blockers[0]
    if (first !== undefined) throw new HarnessError(first.code, first.message)
    return assessment
  }

  summaryForTask(taskId: string): ReviewSummary | null {
    const review = this.findByTask(taskId)
    if (review === null) return null
    const openFindings = this.findings(review.ref).filter((finding) =>
      ['candidate', 'confirmed', 'plausible'].includes(finding.status),
    ).length
    const assessment = this.assess(
      taskId,
      review.headSha ?? undefined,
      true,
      review.diffHash ?? undefined,
    )
    return {
      ref: review.ref,
      round: review.round,
      phase: review.phase,
      risk: review.risk,
      verdict: review.verdict,
      openFindings,
      canComplete: this.gateMode === 'off' ? true : assessment.blockers.length === 0,
    }
  }

  summary(): ReviewOverview {
    const reviews = this.listAll()
    const counts = (statuses: readonly FindingStatus[]): number => {
      const placeholders = statuses.map(() => '?').join(', ')
      const row = this.db
        .prepare(`SELECT COUNT(*) AS n FROM review_findings WHERE status IN (${placeholders})`)
        .get(...statuses) as { n: number }
      return row.n
    }
    const doneWithoutReview = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM tasks t
         LEFT JOIN reviews r ON r.task_id = t.id
         WHERE t.status = 'done'
           AND (r.ref IS NULL OR r.verdict IS NULL OR r.verdict NOT IN ('verified', 'verified-with-waivers', 'exempt'))`,
      )
      .get() as { n: number }
    return {
      open: reviews.filter((review) => isOpenPhase(review.phase)).length,
      verified: reviews.filter(
        (review) => review.verdict === 'verified' || review.verdict === 'verified-with-waivers',
      ).length,
      escalated: reviews.filter((review) => review.phase === 'escalated').length,
      findingsOpen: counts(['candidate', 'confirmed', 'plausible']),
      waivers: counts(['waived']),
      doneWithoutReview: doneWithoutReview.n,
    }
  }

  health(): ReviewHealth {
    const overview = this.summary()
    const reviews = this.listAll()
    const open = reviews.filter((review) => isOpenPhase(review.phase))
    const stale = open.filter((review) => {
      const age = Date.now() - Date.parse(review.updatedAt)
      return Number.isFinite(age) && age > STALE_REVIEW_DAYS * 24 * 60 * 60 * 1000
    })
    const unrefuted = this.db
      .prepare("SELECT COUNT(*) AS n FROM review_findings WHERE status = 'candidate'")
      .get() as { n: number }
    const waiversWithoutDecision = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM review_findings WHERE status = 'waived' AND decision_ref IS NULL",
      )
      .get() as { n: number }
    const roundCapHits = open.filter((review) => review.round >= MAX_REVIEW_ROUNDS).length
    const gapDetails: string[] = []
    for (const review of open) {
      const covered = new Set(
        this.coverage(review.ref)
          .filter((row) => row.round === review.round)
          .map((row) => row.lens),
      )
      const missing = requiredLenses(review.risk).filter((lens) => !covered.has(lens))
      if (missing.length > 0) gapDetails.push(`${review.ref}: ${missing.join(', ')}`)
    }
    const openFindingDetails = this.db
      .prepare(
        "SELECT review_ref, seq, severity, status FROM review_findings WHERE status IN ('candidate', 'confirmed', 'plausible') ORDER BY id ASC LIMIT 20",
      )
      .all() as unknown as {
      review_ref: string
      seq: number
      severity: string
      status: string
    }[]
    return {
      ...overview,
      staleReviews: stale.length,
      unrefutedFindings: unrefuted.n,
      waiversWithoutDecision: waiversWithoutDecision.n,
      roundCapHits,
      coverageGaps: gapDetails.length,
      samples: {
        staleReviews: stale.slice(0, 20).map((review) => review.ref),
        openFindings: openFindingDetails.map(
          (finding) =>
            `${finding.review_ref}#${finding.seq} (${finding.severity}, ${finding.status})`,
        ),
        coverageGaps: gapDetails.slice(0, 20),
      },
    }
  }

  get(ref: string): Review {
    const row = this.selectByRef.get(ref) as unknown as ReviewRow
    if (row === undefined) {
      throw new HarnessError('not-found', `review "${ref}" does not exist`)
    }
    return toReview(row)
  }

  findByTask(taskId: string): Review | null {
    const row = this.selectByTask.get(taskId) as unknown as ReviewRow
    return row === undefined ? null : toReview(row)
  }

  list(filter: ReviewListFilter = {}): Review[] {
    const limit = filter.limit ?? 50
    return this.listAll()
      .filter((review) => filter.taskId === undefined || review.taskId === filter.taskId)
      .filter((review) => filter.phase === undefined || review.phase === filter.phase)
      .reverse()
      .slice(0, limit)
  }

  detail(ref: string): ReviewDetail {
    const review = this.get(ref)
    const findings = this.findings(ref).map((finding) => this.findingDetail(finding))
    const gate = this.assess(
      review.taskId,
      review.headSha ?? undefined,
      true,
      review.diffHash ?? undefined,
    )
    return {
      review,
      findings,
      checks: this.checks(ref),
      coverage: this.coverage(ref),
      gate: { canComplete: gate.blockers.length === 0, blockers: gate.blockers },
    }
  }

  private listAll(): Review[] {
    return (this.selectAll.all() as unknown as ReviewRow[]).map(toReview)
  }

  private findings(ref: string): ReviewFinding[] {
    return (this.selectFindings.all(ref) as unknown as FindingRow[]).map(toFinding)
  }

  private finding(id: number): ReviewFinding {
    const row = this.selectFinding.get(id) as unknown as FindingRow
    if (row === undefined) {
      throw new HarnessError('not-found', `finding "${id}" does not exist`)
    }
    return toFinding(row)
  }

  private findingDetail(finding: ReviewFinding): ReviewFindingDetail {
    const refutations = (
      this.selectRefutationsByFinding.all(finding.id, finding.round) as unknown as RefutationRow[]
    ).map(toRefutation)
    return { ...finding, ref: `${finding.reviewRef}#${finding.seq}`, refutations }
  }

  private recomputeFinding(id: number): void {
    const finding = this.finding(id)
    const refutations = (
      this.selectRefutationsByFinding.all(id, finding.round) as unknown as RefutationRow[]
    ).map(toRefutation)
    if (refutations.length === 0) return
    const confirmed = refutations.filter((row) => row.verdict === 'confirmed').length
    const refuted = refutations.filter((row) => row.verdict === 'refuted').length
    const severity = refutations.reduce<FindingSeverity>(
      (max, row) => (row.severity === null ? max : maxSeverity(max, row.severity)),
      finding.severity,
    )
    const required = isHighSeverity(severity) ? 2 : 1
    let status: FindingStatus = 'plausible'
    if (confirmed > refuted && confirmed >= required) status = 'confirmed'
    else if (refuted > confirmed) status = 'refuted'
    else if (confirmed + refuted === 0) status = 'plausible'
    const latest = refutations.at(-1)
    const refuters = [...new Set(refutations.map((row) => row.refuter))].join(', ')
    this.updateFinding.run(
      severity,
      status,
      refuters.length === 0 ? null : refuters,
      latest?.reasoning ?? null,
      confirmed,
      refuted,
      latest?.oneFactThatWouldOverturn ?? null,
      refutations.length === 0 ? finding.confidence : confirmed / refutations.length,
      finding.classScan,
      finding.resolution,
      finding.decisionRef,
      finding.fixedRound,
      nowIso(),
      status === 'refuted' ? nowIso() : finding.closedAt,
      finding.id,
    )
  }

  private checks(ref: string): ReviewCheck[] {
    return (this.selectChecks.all(ref) as unknown as CheckRow[]).map(toCheck)
  }

  private check(id: number): ReviewCheck {
    const row = this.db
      .prepare('SELECT * FROM review_checks WHERE id = ?')
      .get(id) as unknown as CheckRow
    return toCheck(row)
  }

  private coverage(ref: string): ReviewCoverage[] {
    return (this.selectCoverage.all(ref) as unknown as CoverageRow[]).map(toCoverage)
  }

  private task(id: string): TaskRow {
    const row = this.selectTask.get(id) as unknown as TaskRow
    if (row === undefined) {
      throw new HarnessError('not-found', `task "${id}" does not exist`)
    }
    return row
  }

  private hasRoundActivity(ref: string, round: number): boolean {
    if (this.findings(ref).some((finding) => finding.round === round)) return true
    if (this.checks(ref).some((check) => check.round === round)) return true
    return this.coverage(ref).some((row) => row.round === round)
  }

  private assertOpen(review: Review, action: string): void {
    if (isFinalPhase(review.phase)) {
      throw new HarnessError(
        'review-phase',
        `${review.ref} is ${review.phase}; cannot ${action} a closed review`,
      )
    }
  }

  private assertPhase(review: Review, phases: readonly ReviewPhase[], action: string): void {
    this.assertOpen(review, action)
    if (!phases.includes(review.phase)) {
      throw new HarnessError(
        'review-phase',
        `${review.ref} is in phase "${review.phase}"; cannot ${action} now (allowed: ${phases.join(', ')})`,
      )
    }
  }

  private allocateRef(): string {
    const refs = (this.selectAll.all() as unknown as { ref: string }[]).map((row) => row.ref)
    return `CR${nextNumberIn(refs, REVIEW_REF_PATTERN)}`
  }
}

function validateFinding(input: FindingInput): FindingInput {
  if (!REVIEW_LENSES.includes(input.lens)) {
    throw new HarnessError('invalid', `unknown review lens "${input.lens}"`)
  }
  if (!Number.isSafeInteger(input.line) || input.line < 1) {
    throw new HarnessError('invalid', 'finding line must be a positive integer')
  }
  return {
    ...input,
    title: assertString(input.title, 'finding title', MAX_FINDING_TITLE_LENGTH),
    file: assertString(input.file, 'finding file', MAX_FINDING_CLAIM_LENGTH),
    claim: assertString(input.claim, 'finding claim', MAX_FINDING_CLAIM_LENGTH),
    failureMode: assertString(
      input.failureMode,
      'finding failureMode',
      MAX_FINDING_FAILURE_MODE_LENGTH,
    ),
    evidence: assertString(input.evidence, 'finding evidence', MAX_FINDING_EVIDENCE_LENGTH),
    classKey: optional(input.classKey, 'classKey', MAX_FINDING_CLASS_KEY_LENGTH) ?? undefined,
  }
}

function fingerprintOf(input: FindingInput): string {
  const material = [
    input.lens,
    input.file.toLowerCase(),
    input.classKey ?? '',
    input.title.toLowerCase(),
  ]
    .join('|')
    .replace(/\s+/g, ' ')
    .trim()
  return createHash('sha256').update(material).digest('hex').slice(0, 32)
}

function validatePaths(paths: readonly string[]): void {
  if (paths.length > MAX_REVIEW_CHANGED_PATHS) {
    throw new HarnessError(
      'invalid',
      `changedPaths has ${paths.length} entries; limit ${MAX_REVIEW_CHANGED_PATHS}`,
    )
  }
  for (const path of paths) {
    assertString(path, 'changed path', MAX_REVIEW_PATH_LENGTH)
  }
}

function deriveRisk(paths: readonly string[], linesChanged: number): ReviewRisk {
  if (paths.length === 0) return 'medium'
  if (linesChanged > 800) return 'high'
  if (paths.some((path) => HIGH_RISK_PATH.test(path) || HIGH_RISK_FILE.test(path))) {
    return 'high'
  }
  if (paths.every((path) => LOW_RISK_PATH.test(path) || path.startsWith('docs/'))) return 'low'
  return 'medium'
}

export function requiredLenses(risk: ReviewRisk): ReviewLens[] {
  if (risk === 'low') return ['correctness']
  if (risk === 'high') return ['correctness', 'tests', 'security']
  return ['correctness', 'tests']
}

function isHighSeverity(severity: FindingSeverity): boolean {
  return severity === 'blocker' || severity === 'major'
}

function maxSeverity(a: FindingSeverity, b: FindingSeverity): FindingSeverity {
  const order: Record<FindingSeverity, number> = { nit: 1, minor: 2, major: 3, blocker: 4 }
  return order[a] >= order[b] ? a : b
}

function isOpenPhase(phase: ReviewPhase): boolean {
  return phase === 'hunting' || phase === 'refuting' || phase === 'fixing'
}

function isFinalPhase(phase: ReviewPhase): boolean {
  return (
    phase === 'verified' || phase === 'waived' || phase === 'escalated' || phase === 'abandoned'
  )
}

function optional(value: string | undefined, label: string, maxLength: number): string | null {
  if (value === undefined) return null
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  assertMaxLength(trimmed, label, maxLength)
  return trimmed
}

function requireDecision(db: DatabaseSync, ref: string | undefined): string {
  const decisionRef = assertString(ref, 'decisionRef', 16)
  const row = db.prepare('SELECT ref FROM decisions WHERE ref = ?').get(decisionRef)
  if (row === undefined) {
    throw new HarnessError('not-found', `decision "${decisionRef}" does not exist`)
  }
  return decisionRef
}

function toReview(row: ReviewRow): Review {
  return {
    ref: row.ref,
    taskId: row.task_id,
    round: row.round,
    phase: row.phase as ReviewPhase,
    risk: row.risk as ReviewRisk,
    baseRef: row.base_ref,
    baseSha: row.base_sha,
    headSha: row.head_sha,
    diffHash: row.diff_hash,
    changedPaths: parsePaths(row.changed_paths),
    oracle: row.oracle,
    reviewer: row.reviewer,
    freshContext: row.fresh_context === 1,
    summary: row.summary,
    verdict: row.verdict as ReviewVerdict | null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
  }
}

function toFinding(row: FindingRow): ReviewFinding {
  return {
    id: row.id,
    reviewRef: row.review_ref,
    round: row.round,
    seq: row.seq,
    fingerprint: row.fingerprint,
    classKey: row.class_key,
    lens: row.lens as ReviewLens,
    severity: row.severity as FindingSeverity,
    status: row.status as FindingStatus,
    title: row.title,
    file: row.file,
    line: row.line,
    claim: row.claim,
    failureMode: row.failure_mode,
    evidence: row.evidence,
    introducedByDiff: row.introduced_by_diff === 1,
    confidence: row.confidence,
    refuter: row.refuter,
    rebuttal: row.rebuttal,
    votesFor: row.votes_for,
    votesAgainst: row.votes_against,
    oneFactThatWouldOverturn: row.one_fact_that_would_overturn,
    classScan: row.class_scan,
    resolution: row.resolution,
    decisionRef: row.decision_ref,
    fixedRound: row.fixed_round,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
  }
}

function toRefutation(row: RefutationRow): ReviewRefutation {
  return {
    id: row.id,
    reviewRef: row.review_ref,
    findingId: row.finding_id,
    round: row.round,
    refuter: row.refuter,
    verdict: row.verdict as RefutationVerdict,
    reasoning: row.reasoning,
    killStrategy: row.kill_strategy,
    evidence: row.evidence,
    severity: row.severity as FindingSeverity | null,
    oneFactThatWouldOverturn: row.one_fact_that_would_overturn,
    repro: row.repro,
    createdAt: row.created_at,
  }
}

function toCheck(row: CheckRow): ReviewCheck {
  return {
    id: row.id,
    reviewRef: row.review_ref,
    round: row.round,
    name: row.name,
    command: row.command,
    exitCode: row.exit_code,
    outputDigest: row.output_digest,
    outputExcerpt: row.output_excerpt,
    createdAt: row.created_at,
  }
}

function toCoverage(row: CoverageRow): ReviewCoverage {
  return {
    id: row.id,
    reviewRef: row.review_ref,
    round: row.round,
    lens: row.lens as ReviewLens,
    filesExamined: row.files_examined,
    result: row.result as CoverageResult,
    evidence: row.evidence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function parsePaths(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((entry): entry is string => typeof entry === 'string')
  } catch {
    return []
  }
}
