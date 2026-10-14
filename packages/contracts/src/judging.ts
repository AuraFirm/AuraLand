import { z } from "zod";

// Judging vocabulary shared by the control plane, the screens and (by fixture) the Go agent.

// Languages the judge can run. Each has a versioned profile in the agent (compiler, flags, limits).
export const JUDGE_LANGUAGES = ["cpp", "c", "python3"] as const;
export const judgeLanguageSchema = z.enum(JUDGE_LANGUAGES);
export type JudgeLanguage = z.infer<typeof judgeLanguageSchema>;

export const SUBMISSION_STATES = [
    "queued",
    "judging",
    "judged",
    "failed_system",
    "cancelled",
] as const;
export const submissionStateSchema = z.enum(SUBMISSION_STATES);

// docs/kit/07 section 4.3. SE is a system error: never the participant's fault.
export const VERDICTS = ["AC", "WA", "TLE", "MLE", "OLE", "RTE", "CE", "PARTIAL", "SE"] as const;
export const verdictSchema = z.enum(VERDICTS);
export type Verdict = z.infer<typeof verdictSchema>;

// A single test cannot be PARTIAL (that is a whole-submission outcome).
export const testVerdictSchema = z.enum(["AC", "WA", "TLE", "MLE", "OLE", "RTE", "CE", "SE"]);
export type TestVerdict = z.infer<typeof testVerdictSchema>;
