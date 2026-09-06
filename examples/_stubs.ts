// Stand-ins for the parts of your application the examples call. Replace with your own.
export async function sendEmail(to: string, template: string, data: unknown): Promise<void> {}
export async function postWebhook(url: string, body: unknown): Promise<{ status: number }> { return { status: 200 }; }
export async function reserveFunds(accountId: string, amount: number): Promise<string> { return "hold-1"; }
export async function sendToBank(accountId: string, amount: number, reference: string): Promise<string> { return "bank-ref-1"; }
export async function releaseHold(holdId: string): Promise<void> {}
export async function chargeCard(orderId: string, amount: number): Promise<string> { return "charge-1"; }
export async function refundCharge(chargeId: string): Promise<void> {}
export async function createShipment(orderId: string): Promise<string> { return "ship-1"; }
export async function transcode(inputPath: string, onProgress: (pct: number) => Promise<void>, signal: AbortSignal): Promise<string> { return "out.mp4"; }
export async function embed(texts: string[]): Promise<number[][]> { return texts.map(() => [0]); }
export async function buildReport(day: string): Promise<Buffer> { return Buffer.from(""); }
export async function upload(path: string, body: Buffer): Promise<void> {}
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
export class RateLimitError extends Error { retryAfterMs = 1000; }
