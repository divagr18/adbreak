/**
 * The safety model. A pure function, deliberately free of any LLM involvement:
 * the model may propose a diagnosis, but what the system is *allowed to do*
 * about it is decided here, by code you can read and test.
 *
 * "We let an LLM run remediation against production" is a red flag to any
 * operator. "A deterministic policy gate authorises a pre-written,
 * precondition-checked runbook that the LLM only selected via lookup table" is
 * an architecture an SRE will sign off on.
 */

export type Tier = 'T0' | 'T1' | 'T2' | 'T3';
export type Verdict = 'ALLOW' | 'APPROVE' | 'BLOCK';

export interface Scope {
  deviceClass: string | null;
  cdn: string | null;
  region: string | null;
  /** True when the change touches content delivery rather than ad signalling. */
  contentPath?: boolean;
}

/**
 * Classify how far a change can reach. Narrow scopes are auto-executable;
 * anything that could affect every viewer is not.
 */
export function classify(scope: Scope): Tier {
  if (scope.contentPath) return 'T3';
  const { deviceClass, region } = scope;
  // A single device class inside a single region.
  if (deviceClass && region) return 'T1';
  // A device class everywhere, or an entire region.
  if (deviceClass || region) return 'T2';
  // Unscoped: channel-wide.
  return 'T3';
}

export interface GateInput {
  tier: Tier;
  /** During a live event the bar for channel-wide change rises to "never". */
  eventMode: boolean;
  /** Every runbook precondition must hold before anything executes. */
  preconditionsMet: boolean;
  /** Fraction of the dollar-denominated error budget still unspent (0..1). */
  errorBudgetRemaining: number;
}

export interface GateResult {
  verdict: Verdict;
  reason: string;
}

export function gate(input: GateInput): GateResult {
  const { tier, eventMode, preconditionsMet, errorBudgetRemaining } = input;

  // Preconditions are the runbook's own statement of when it is safe to run.
  // Failing them is a hard stop regardless of tier — this is what stops the
  // agent "fixing" something it has misdiagnosed.
  if (!preconditionsMet) {
    return { verdict: 'BLOCK', reason: 'runbook preconditions not met' };
  }
  if (errorBudgetRemaining <= 0 && tier !== 'T0') {
    return { verdict: 'BLOCK', reason: 'error budget exhausted' };
  }

  switch (tier) {
    case 'T0':
      return { verdict: 'ALLOW', reason: 'single session, auto-remediable' };
    case 'T1':
      return { verdict: 'ALLOW', reason: 'one device class in one region, auto-remediable' };
    case 'T2':
      return { verdict: 'APPROVE', reason: 'region-wide or device-class-global change needs a human' };
    case 'T3':
      return eventMode
        ? { verdict: 'BLOCK', reason: 'channel-wide change blocked during a live event' }
        : { verdict: 'APPROVE', reason: 'channel-wide or content-path change needs two approvers' };
  }
}
