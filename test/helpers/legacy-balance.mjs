// Köhnə balans modelini yoxlayan testlər üçün: yeni hesaba 2 AZN pulsuz balans, pulsuz sınaq cavabları yox.
// (Abunə modelində defolt: BILLING_FREE_AZN=0, BILLING_TRIAL_REPLIES=100 — test/plans.test.mjs)
export function legacyBalanceEnv() {
  if (process.env.BILLING_FREE_AZN === undefined) process.env.BILLING_FREE_AZN = "2";
  process.env.BILLING_TRIAL_REPLIES = "0";
}
legacyBalanceEnv();
