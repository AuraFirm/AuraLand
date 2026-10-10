import { input } from "../lib/styles.ts";

export type Visibility = "private" | "org";

// Who can see a task. "public" and "licensed" exist in the data but are not offered until the
// marketplace stage.
export function VisibilitySelect({
    id,
    value,
    onChange,
}: {
    id: string;
    value: Visibility;
    onChange: (value: Visibility) => void;
}) {
    return (
        <>
            <label htmlFor={id}>Who can see it</label>
            <select
                id={id}
                className={input}
                value={value}
                onChange={(e) => onChange(e.target.value === "org" ? "org" : "private")}
            >
                <option value="private">only setters and reviewers</option>
                <option value="org">every member, once released</option>
            </select>
        </>
    );
}
