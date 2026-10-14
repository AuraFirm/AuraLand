// The watermark module's public surface for other modules (the judge protocol).
export {
    type RecordOutcome,
    recordDeliveryBundle,
    type WatermarkInput,
    watermarkJobInput,
} from "./queries.ts";
export { harnessCannotRun, type Judgement, judgeReport, sameVerdicts } from "./rules.ts";
