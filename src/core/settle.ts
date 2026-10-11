import type { CostLine } from "./types.js";

export type Transfer = { from: string; to: string; amount: number };

/**
 * Equal split: everyone ends up paying the average. People who paid less than
 * the average pay those who paid more, largest amounts first.
 */
export function settleUp(costs: CostLine[]): { average: number; transfers: Transfer[] } {
  if (!costs.length) return { average: 0, transfers: [] };
  const average = costs.reduce((s, c) => s + c.total, 0) / costs.length;
  const owe = costs.map((c) => ({ person: c.person, amount: average - c.total })).filter((x) => x.amount > 0.5).sort((a, b) => b.amount - a.amount);
  const owed = costs.map((c) => ({ person: c.person, amount: c.total - average })).filter((x) => x.amount > 0.5).sort((a, b) => b.amount - a.amount);
  const transfers: Transfer[] = [];
  let i = 0;
  let j = 0;
  while (i < owe.length && j < owed.length) {
    const amount = Math.min(owe[i].amount, owed[j].amount);
    if (Math.round(amount) > 0) transfers.push({ from: owe[i].person, to: owed[j].person, amount: Math.round(amount) });
    owe[i].amount -= amount;
    owed[j].amount -= amount;
    if (owe[i].amount < 0.5) i++;
    if (owed[j].amount < 0.5) j++;
  }
  return { average: Math.round(average), transfers };
}
