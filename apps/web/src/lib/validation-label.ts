import type { ValidationReport } from "@aura/contracts/api/validation";

// How a validation report is named to people (ADR 0029, invariant 4): plain "Validated" only for a
// report from a reviewed production node. A development node's report says so in the same sentence,
// because the sandbox it ran in has not been independently reviewed.
export function validationLabel(report: ValidationReport): string {
    if (!report.passed) return "Did not pass validation";
    return report.attestation === "production"
        ? "Validated"
        : "Validated on a development sandbox only (the sandbox has not been independently reviewed)";
}
