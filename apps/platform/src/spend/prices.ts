/**
 * What the platform's own usage costs, in USD (Cloudflare list prices on Workers Paid, past the
 * included usage; checked 2026-10-11, https://developers.cloudflare.com/containers/pricing/ and
 * https://developers.cloudflare.com/browser-rendering/pricing/).
 *
 * Containers bill memory and disk as provisioned and vCPU as used; the meter can't see CPU use, so
 * it charges every vCPU as busy: an upper bound (a missing signal only raises the estimate). LLM
 * calls are priced where they are made (packages/tour/src/budget.ts) and arrive here in USD.
 */
import type { InstanceType } from "@app/ci-engine";

const MEMORY_USD_PER_GIB_SECOND = 0.0000025;
const VCPU_USD_PER_SECOND = 0.00002;
const DISK_USD_PER_GB_SECOND = 0.00000007;

/** Containers instance types: vCPUs, memory (GiB) and disk (GB). */
export const INSTANCE_SPECS: Record<
  InstanceType,
  { vcpu: number; memGib: number; diskGb: number }
> = {
  lite: { vcpu: 1 / 16, memGib: 0.25, diskGb: 2 },
  "standard-1": { vcpu: 0.5, memGib: 4, diskGb: 8 },
  "standard-2": { vcpu: 1, memGib: 6, diskGb: 12 },
  "standard-3": { vcpu: 2, memGib: 8, diskGb: 16 },
  "standard-4": { vcpu: 4, memGib: 12, diskGb: 20 },
};

/** USD per second of one running container of `instance` (every vCPU busy). */
export function containerUsdPerSecond(instance: InstanceType): number {
  const s = INSTANCE_SPECS[instance] ?? INSTANCE_SPECS["standard-4"];
  return (
    s.vcpu * VCPU_USD_PER_SECOND +
    s.memGib * MEMORY_USD_PER_GIB_SECOND +
    s.diskGb * DISK_USD_PER_GB_SECOND
  );
}

export function containerUsd(instance: InstanceType, ms: number): number {
  return (Math.max(0, ms) / 1000) * containerUsdPerSecond(instance);
}

/** Browser Run: $0.09 per browser-hour. */
export const BROWSER_USD_PER_HOUR = 0.09;

export function browserUsd(ms: number): number {
  return (Math.max(0, ms) / 3_600_000) * BROWSER_USD_PER_HOUR;
}
