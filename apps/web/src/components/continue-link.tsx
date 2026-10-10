"use client";

import { useEffect, useState } from "react";
import { takeNext } from "../lib/next-path.ts";

// The link shown after a successful sign-in. It goes where the person was headed when they were asked
// to sign in (a path on this site, checked), otherwise to the fallback.
export function ContinueLink({ fallback, label }: { fallback: string; label: string }) {
    const [href, setHref] = useState(fallback);
    useEffect(() => setHref(takeNext(fallback)), [fallback]);
    return (
        <a className="text-accent underline" href={href}>
            {label}
        </a>
    );
}
