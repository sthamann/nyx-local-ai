import { parameterBillions } from '../agent/toolSchemas';
import type { BenchmarkScores, BenchSetupAdvice, ModelInfo } from '../types';

/** Models that never make sense as a chat/agent target. */
const NON_CHAT_RE = /embed|moondream|whisper/i;

function scoredModels(
  models: ModelInfo[],
  benchmarks: Record<string, BenchmarkScores>,
): Array<{ m: ModelInfo; s: BenchmarkScores }> {
  return models
    .filter((m) => !NON_CHAT_RE.test(m.id))
    .map((m) => ({ m, s: benchmarks[m.key] }))
    .filter((x): x is { m: ModelInfo; s: BenchmarkScores } => Boolean(x.s));
}

/** Turns stored benchmark scores into a concrete setup recommendation. */
export function computeBenchAdvice(
  models: ModelInfo[],
  benchmarks: Record<string, BenchmarkScores>,
): BenchSetupAdvice | undefined {
  const scored = scoredModels(models, benchmarks);
  if (scored.length === 0) {
    return undefined;
  }
  const overall = (s: BenchmarkScores): number => (s.tool + s.edit + s.judge) / 3;
  const daily = [...scored].sort((a, b) => overall(b.s) - overall(a.s))[0];
  const utility = scored
    .filter((x) => (parameterBillions(x.m.id) ?? 99) <= 8 && x.m.key !== daily.m.key)
    .sort((a, b) => a.s.avgMs - b.s.avgMs)[0];
  const fim = models
    .filter((m) => /coder|codellama|starcoder|codegemma/i.test(m.id))
    .map((m) => ({ m, size: parameterBillions(m.id) ?? 99 }))
    .filter((x) => x.size <= 8)
    .sort((a, b) => a.size - b.size)[0];
  const advice: BenchSetupAdvice = { daily: { key: daily.m.key, label: daily.m.label } };
  if (utility) {
    advice.utility = { key: utility.m.key, label: utility.m.label };
  }
  if (fim) {
    advice.autocomplete = { model: fim.m.id, label: fim.m.label };
  }
  return advice;
}

/**
 * Benchmark-based multi-model routing (opt-in via nyx.benchmarkRouting):
 * the judgment-best model plans, the edit-precision winner executes. Needs
 * at least two benchmarked, reachable models; otherwise the user's selection
 * stays untouched.
 */
export function routeByBenchmarks(
  models: ModelInfo[],
  benchmarks: Record<string, BenchmarkScores>,
  selected: ModelInfo,
): { plan: ModelInfo; execution?: ModelInfo } {
  const scored = scoredModels(models, benchmarks);
  if (scored.length < 2) {
    return { plan: selected };
  }
  const best = (key: 'judge' | 'edit'): ModelInfo => [...scored].sort((a, b) => b.s[key] - a.s[key])[0].m;
  const plan = best('judge');
  const execution = best('edit');
  return { plan, execution: execution.key === plan.key ? undefined : execution };
}
