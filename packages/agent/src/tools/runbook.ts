/**
 * Runbooks are versioned YAML on disk, loaded once at startup and never
 * generated at runtime. The model may only *select* one, by id, via a lookup
 * table — it cannot author an action, and it cannot widen a blast radius.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { Tier } from '../policy/blast-radius.js';

export interface RunbookAction {
  type: string;
  target: string;
  method: string;
  path: string;
  body: Record<string, unknown>;
}

export interface Runbook {
  id: string;
  version: number;
  title: string;
  applies_to: string[];
  blast_radius: Tier;
  preconditions: { id: string; description: string; expr: string; window: string }[];
  predicted_impact: { rrr_delta: number; description: string; risk: string };
  actions: RunbookAction[];
  verification: { expr: string; window: string; timeout_s: number };
  rollback: RunbookAction[];
}

const RUNBOOK_DIR = process.env.RUNBOOK_DIR ?? '/app/runbooks';

export function loadRunbooks(dir = RUNBOOK_DIR): Map<string, Runbook> {
  const out = new Map<string, Runbook>();
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.yaml'))) {
    const rb = parse(readFileSync(join(dir, f), 'utf8')) as Runbook;
    out.set(rb.id, rb);
  }
  return out;
}

/**
 * Failure class -> runbook. This table, not the model, decides what runs.
 * An unmapped failure class produces no remediation at all, by design.
 */
export const RUNBOOK_FOR: Record<string, string | undefined> = {
  F07: 'rb-beacon-fallback',
};

const TARGETS: Record<string, string> = {
  ssai: process.env.SSAI_URL ?? 'http://ssai:3000',
  ads: process.env.ADS_URL ?? 'http://ads:3000',
  edge: process.env.EDGE_URL ?? 'http://edge:3000',
  packager: process.env.PACKAGER_URL ?? 'http://packager:3000',
};

/** Substitute $device etc. into a runbook's templated strings. */
export function substitute<T>(value: T, vars: Record<string, string>): T {
  if (typeof value === 'string') {
    return value.replace(/\$(\w+)/g, (m, k: string) => vars[k] ?? m) as unknown as T;
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, vars)) as unknown as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, substitute(v, vars)]),
    ) as T;
  }
  return value;
}

export interface ExecutedStep {
  action: string;
  status: number;
  ok: boolean;
}

export async function execute(
  actions: RunbookAction[],
  vars: Record<string, string>,
): Promise<ExecutedStep[]> {
  const steps: ExecutedStep[] = [];
  for (const raw of actions) {
    const a = substitute(raw, vars);
    const base = TARGETS[a.target];
    if (!base) throw new Error(`runbook targets unknown service: ${a.target}`);
    const res = await fetch(`${base}${a.path}`, {
      method: a.method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(a.body),
    });
    steps.push({
      action: `${a.method} ${a.target}${a.path} ${JSON.stringify(a.body)}`,
      status: res.status,
      ok: res.ok,
    });
    if (!res.ok) throw new Error(`runbook action failed: ${a.target}${a.path} -> ${res.status}`);
  }
  return steps;
}
