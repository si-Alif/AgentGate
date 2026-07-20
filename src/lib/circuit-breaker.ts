export type BreakState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitBreakerConfig{
  failureThreshold: number; // Number of failures before opening the circuit
  cooldownMs : number; // Time to wait before attempting to close the circuit
}

const DEFAULT_CONFIG : CircuitBreakerConfig = {
  failureThreshold : 3 ,
  cooldownMs : 15_000
}

export class CircuitBreaker {
  private state : BreakState = "CLOSED";
  private consecutiveFailureCount : number = 0;
  private lastOpenedAt: number | null = null;
  private probeInFlight : boolean = false;

  constructor(private config : CircuitBreakerConfig = DEFAULT_CONFIG) {}

  // check if the incoming request can even attempt to call redis or not first
  public canAttempt() : boolean {
    if (this.state === "CLOSED") return true;

    if (this.state === "OPEN") {
      const elapsed = Date.now() - (this.lastOpenedAt ?? 0);
      if (elapsed >= this.config.cooldownMs) {
        this.state = "HALF_OPEN";
        this.probeInFlight = false; // reset probe state for the next attempt
      }else{
        return false;
      }
    }

    if (this.probeInFlight) return false; // only allow one probe attempt in HALF_OPEN state
    this.probeInFlight = true;

    return true;
  }

  onSuccess() : void {
    this.consecutiveFailureCount = 0;
    this.state = "CLOSED";
    this.lastOpenedAt = null;
    this.probeInFlight = false;
  }

  // can be closed either on consecutive failures or maybe on failure while the circuit is half open
  onFailure() : void {
    this.consecutiveFailureCount++;
    if (this.state === "HALF_OPEN" ||  this.consecutiveFailureCount >= this.config.failureThreshold) {
      this.state = "OPEN";
      this.lastOpenedAt = Date.now();
    }
    this.probeInFlight = false; // reset probe state for the next attempt
  }


  getState() : BreakState {
    return this.state;
  }

  //
  reset() : void {
    this.state = "CLOSED";
    this.consecutiveFailureCount = 0;
    this.lastOpenedAt = null;
    this.probeInFlight = false;
  }
}