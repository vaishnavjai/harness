export interface RecoveryWitness {
  ready: boolean; throws: number;
  executed: boolean; boot: string; clipboardAttempts: number; trustedClicks: boolean[];
  copies: string[]; errors: string[]; rejections: string[];
  fetches: { url: string; method: string; body: string; keepalive: boolean; callStack: string }[];
  beacons: string[];
}
declare global { interface Window { crashRecovery?: RecoveryWitness } }
export interface RecoverySnapshot {
  heading: string; text: string; stack: string; expanded: string | null; buttons: string[];
  injected: number; href: string; witness: RecoveryWitness;
}
