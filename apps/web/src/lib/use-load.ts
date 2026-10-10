"use client";

import { useCallback, useEffect, useState } from "react";
import { ApiError, messageOf } from "./api.ts";

interface Loaded<T> {
    readonly data: T | null;
    readonly error: string;
    readonly reload: () => void;
}

// Loads data when a component appears and again on demand. A 401 sends the person to sign in.
export function useLoad<T>(loader: () => Promise<T>): Loaded<T> {
    const [data, setData] = useState<T | null>(null);
    const [error, setError] = useState("");
    const [round, setRound] = useState(0);

    useEffect(() => {
        void round;
        let live = true;
        loader().then(
            (value) => {
                if (live) {
                    setData(value);
                    setError("");
                }
            },
            (failure: unknown) => {
                if (failure instanceof ApiError && failure.status === 401) {
                    window.location.replace("/sign-in");
                } else if (live) {
                    setError(messageOf(failure));
                }
            },
        );
        return () => {
            live = false;
        };
    }, [loader, round]);

    const reload = useCallback(() => setRound((n) => n + 1), []);
    return { data, error, reload };
}
