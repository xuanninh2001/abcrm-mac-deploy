export type CriterionKind = "knockout" | "must_have" | "scored";
export type Evaluation = "rule" | "ai_judged";
export type UnknownPolicy = "neutral" | "penalize" | "block";
export type Result = "pass" | "fail" | "unknown" | "skipped";
export type Tier = "A" | "B" | "C" | "D";

export interface CriterionDef {
  key: string;
  kind: CriterionKind;
  evaluation: Evaluation;
  weight: number;
  evidenceRequired: boolean;
  unknownPolicy: UnknownPolicy;
  unknownPenalty: number;
  orderNo: number;
  rule?: unknown;
}

export interface Evidence { id: string; snippet: string }
export interface Quote { evidenceId: string; text: string }
export interface VerifiedQuote extends Quote { verified: boolean }

export interface CriterionOutcome {
  key: string;
  result: Result;
  quotes: VerifiedQuote[];
}

export interface TierThresholds { A: number; B: number; C: number }
