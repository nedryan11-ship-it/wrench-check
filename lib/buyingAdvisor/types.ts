// lib/buyingAdvisor/types.ts
//
// Input contract for the Buying Advisor Chat.
// Call-site (maintenance audit page) is responsible for populating this
// from the MaintenanceDebtAuditResult + PriorityOutput.

export type BuyingAdvisorChatContext = {
  vehicle: {
    vin?: string | null;
    year?: number | null;
    make?: string | null;
    model?: string | null;
    trim?: string | null;
    currentMileage?: number | null;
  };

  maintenanceDebtEstimate?: {
    low?: number | null;
    high?: number | null;
  };

  verdict?: "clean" | "light_catch_up" | "maintenance_debt_risk" | "high_risk" | "incomplete";

  /** 1–3 highest-priority items from the prioritization engine */
  topPriorityItems: Array<{
    canonicalService: string;
    displayName: string;
    reason: string;
    severity: "low" | "medium" | "high";
    estimatedCostLow?: number | null;
    estimatedCostHigh?: number | null;
    priority: "high" | "medium" | "low";
  }>;

  /** Items classified as missing_service, overdue, or due_now */
  missingOrOverdueItems: Array<{
    displayName: string;
    reasoning: string;
    estimatedCostLow?: number | null;
    estimatedCostHigh?: number | null;
    severity: "low" | "medium" | "high";
  }>;

  vehicleWatchouts: Array<{
    issue: string;
    severity: "low" | "medium" | "high";
    relatedServices: string[];
  }>;

  negotiationLeverage?: {
    level: "low" | "moderate" | "strong";
    reasons: string[];
  };

  conversation: Array<{
    role: "user" | "assistant";
    content: string;
  }>;

  /**
   * The advisor infers this from the conversation and context.
   * If provided by the UI, it allows the advisor to tailor the opening.
   */
  userGoal?:
    | "decide"
    | "negotiate"
    | "understand_risk"
    | "ask_seller"
    | "walk_away_check"
    | null;
};

export type BuyingAdvisorResponse = {
  reply: string;
  /** Updated inferred goal — UI can surface this as a quick-select */
  inferredGoal?: BuyingAdvisorChatContext["userGoal"];
  /** Chat phase the advisor determined we are in */
  phase?: "orient" | "verify" | "strategy" | "action" | "done";
};
