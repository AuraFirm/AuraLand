// The one place in the web app that puts HTML into a page. The HTML must come from the API's
// renderMarkdownSafe (docs/kit/08): the API builds it from an allowlist and the page's CSP forbids
// inline scripts and styles, so even a renderer bug could not run code. A Semgrep rule bans
// dangerouslySetInnerHTML everywhere else.
export function SafeHtml({ html, label }: { html: string; label: string }) {
    return (
        <section
            className="statement"
            aria-label={label}
            // biome-ignore lint/security/noDangerouslySetInnerHtml: the one audited use, see above
            dangerouslySetInnerHTML={{ __html: html }} // tigerlint-allow: no-raw-html -- the one audited use
        />
    );
}
