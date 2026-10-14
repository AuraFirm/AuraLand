// The validation module's public surface for other modules (the judge protocol).
export { readValidationWork, settleValidation, type ValidationWork } from "./queries.ts";
export { type Evaluation, evaluateValidation } from "./rules.ts";
