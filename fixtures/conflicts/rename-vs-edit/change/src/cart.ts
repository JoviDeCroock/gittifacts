export interface Item {
  price: number;
  qty: number;
}

function lineTotal(item: Item): number {
  return item.price * item.qty;
}

export function cartTotal(items: Item[], discount = 0): number {
  let total = 0;
  for (const item of items) total += lineTotal(item);
  return Math.max(0, total - discount);
}
