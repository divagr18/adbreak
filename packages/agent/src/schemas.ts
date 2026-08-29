/**
 * Every step's output is schema-validated. The LLM fills in reasoning inside a
 * step; it never decides what the next step is, and it never returns free text
 * that later code has to guess at.
 */
import { z } from 'zod';

export const FAILURE_CLASSES = ['F01', 'F02', 'F03', 'F04', 'F07', 'F08', 'F09', 'UNKNOWN'] as const;
export const STAGES = [
  'signal',
  'package',
  'decide',
  'condition',
  'stitch',
  'deliver',
  'play',
  'beacon',
  'unknown',
] as const;

/** Step 1 — deterministic, built from the firing Grafana alert instance. */
export const Incident = z.object({
  id: z.string(),
  channel: z.string(),
  region: z.string(),
  deviceClass: z.string(),
  startedAt: z.string(),
  rrr: z.number(),
});
export type Incident = z.infer<typeof Incident>;

/** Step 2 — fast classification. */
export const Triage = z.object({
  severity: z.enum(['critical', 'major', 'minor']),
  suspectedStages: z.array(z.enum(STAGES)).min(1).max(4),
  affectedDimensions: z.object({
    deviceClass: z.string().nullable(),
    cdn: z.string().nullable(),
    region: z.string().nullable(),
  }),
  reasoning: z.string(),
});
export type Triage = z.infer<typeof Triage>;

/** Step 3 — one per parallel correlation branch. */
export const Evidence = z.object({
  branch: z.string(),
  queriesIssued: z.array(z.string()),
  findings: z.array(z.string()),
  /** What this branch believes the data shows, in one line. */
  conclusion: z.string(),
});
export type Evidence = z.infer<typeof Evidence>;

/** Step 4 — the diagnosis. */
export const Hypothesis = z.object({
  failureClass: z.enum(FAILURE_CLASSES),
  stage: z.enum(STAGES),
  cause: z.string(),
  confidence: z.number().min(0).max(1),
  supportingEvidence: z.array(z.string()).min(1),
  /** Dimensions the fault is scoped to — drives the blast radius tier. */
  scope: z.object({
    deviceClass: z.string().nullable(),
    cdn: z.string().nullable(),
    region: z.string().nullable(),
  }),
  predictedSignature: z.string(),
});
export type Hypothesis = z.infer<typeof Hypothesis>;

/** Step 5 — the adversarial pass. */
export const Falsification = z.object({
  survived: z.boolean(),
  testsAttempted: z.array(z.string()).min(1),
  contradictions: z.array(z.string()),
  verdict: z.string(),
});
export type Falsification = z.infer<typeof Falsification>;

/** Step 9 — the write-up. */
export const Documentation = z.object({
  incidentTitle: z.string(),
  postmortem: z.string().min(50),
  cfoBrief: z.string().min(30),
});
export type Documentation = z.infer<typeof Documentation>;
