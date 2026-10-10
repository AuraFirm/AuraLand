// Test cases for html-rules.yml. This folder is excluded from Biome, tigerlint and tsc.
declare const html: string;

// ruleid: aura-no-dangerously-set-inner-html
export const bad = <div dangerouslySetInnerHTML={{ __html: html }} />;

// ok: aura-no-dangerously-set-inner-html
export const fine = <div>{html}</div>;
