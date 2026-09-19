// Tracks recent login attempts per client in memory to throttle authentication.
export class LoginRateLimiter {
  private readonly attempts = new Map<string, number[]>();

  // Create a limiter with its attempt cap and rolling failure window.
  constructor(private readonly limit = 5, private readonly windowMs = 5 * 60_000) {}

  // Decide whether the key may attempt another login within the failure window.
  allowed(key: string, now = Date.now()): boolean {
    const recent = (this.attempts.get(key) || []).filter((value) => value > now - this.windowMs);
    this.attempts.set(key, recent);
    return recent.length < this.limit;
  }

  // Record a failed attempt for the key at the given time.
  fail(key: string, now = Date.now()): void {
    const recent = (this.attempts.get(key) || []).filter((value) => value > now - this.windowMs);
    recent.push(now);
    this.attempts.set(key, recent);
  }

  // Forget the recorded attempts of a key, for example after a successful login.
  clear(key: string): void {
    this.attempts.delete(key);
  }
}
