// All time flows through this port so simulation can control it. Units are unix milliseconds.

export interface Clock {
    nowUnixMs(): number;
}

export const systemClock: Clock = {
    nowUnixMs: () => Date.now(),
};
