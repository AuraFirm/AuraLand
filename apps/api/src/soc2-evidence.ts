// Evidence for SOC 2 readiness, rendered as a document (no I/O). Each item names the control area it supports, what was checked,
// what was found, and whether that counts as evidence. "Not evidenced" is a normal and useful answer: the point is a dated, honest
// list of what the repository and database can show on their own. This is NOT an audit and NOT a SOC 2 report.

export type EvidenceStatus = "evidenced" | "partial" | "not_evidenced";

export interface EvidenceItem {
    // The Trust Services Criteria area, informally (for example "CC8.1 change management").
    readonly area: string;
    readonly check: string;
    readonly found: string;
    readonly status: EvidenceStatus;
}

const LABEL: Record<EvidenceStatus, string> = {
    evidenced: "evidenced",
    partial: "partial",
    not_evidenced: "NOT evidenced",
};

export function renderEvidence(items: readonly EvidenceItem[], date: string): string {
    const counts = { evidenced: 0, partial: 0, not_evidenced: 0 };
    for (const item of items) counts[item.status]++;
    const lines = [
        `# SOC 2 readiness evidence, ${date}`,
        "",
        "Collected automatically by `node apps/api/src/soc2-evidence-cli.ts` from this repository, its CI configuration, GitHub's rules for `main` and a",
        "freshly migrated database. **This is not an audit and not a SOC 2 report.** It lists what can be shown without a person or a cloud account;",
        "policies, access reviews, vendor management, backups, monitoring and incident response need people and systems that do not exist yet.",
        "",
        `Summary: ${counts.evidenced} evidenced, ${counts.partial} partial, ${counts.not_evidenced} not evidenced.`,
        "",
        "| Area | Check | Found | Status |",
        "|---|---|---|---|",
    ];
    for (const item of items)
        lines.push(
            `| ${item.area} | ${item.check} | ${item.found.replaceAll("|", "/")} | ${LABEL[item.status]} |`,
        );
    return `${lines.join("\n")}\n`;
}
