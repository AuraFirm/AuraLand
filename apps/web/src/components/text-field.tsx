import { input } from "../lib/styles.ts";

// A labelled single-line field, so forms with many fields stay short and every label is tied to its
// input for screen readers.
export function TextField(props: {
    id: string;
    label: string;
    value: string;
    onChange: (value: string) => void;
    type?: "text" | "datetime-local";
    pattern?: string;
    maxLength?: number;
}) {
    return (
        <>
            <label htmlFor={props.id}>{props.label}</label>
            <input
                id={props.id}
                type={props.type ?? "text"}
                className={input}
                required
                value={props.value}
                {...(props.pattern === undefined ? {} : { pattern: props.pattern })}
                {...(props.maxLength === undefined ? {} : { maxLength: props.maxLength })}
                onChange={(e) => props.onChange(e.target.value)}
            />
        </>
    );
}
