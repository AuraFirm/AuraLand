import type { DraftState } from "@aura/contracts/exam-sync";

// The candidate's drafts on this computer (IndexedDB), so that a closed tab, a crash or a dropped connection loses
// nothing: the page saves here first and to the server second, and forgets nothing until the server has
// acknowledged it. One small store; the key names the exam and the problem.

const DATABASE = "aura-exam-drafts";
const STORE = "drafts";

function open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DATABASE, 1);
        request.onupgradeneeded = () => request.result.createObjectStore(STORE);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

const keyOf = (examId: string, label: string) => `${examId}:${label}`;

export async function loadLocalDraft(examId: string, label: string): Promise<DraftState | null> {
    const db = await open();
    return new Promise((resolve, reject) => {
        const request = db.transaction(STORE).objectStore(STORE).get(keyOf(examId, label));
        request.onsuccess = () => {
            db.close();
            const value: unknown = request.result;
            resolve(isDraft(value) ? value : null);
        };
        request.onerror = () => {
            db.close();
            reject(request.error);
        };
    });
}

export async function saveLocalDraft(
    examId: string,
    label: string,
    state: DraftState,
): Promise<void> {
    const db = await open();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE, "readwrite");
        transaction.objectStore(STORE).put(state, keyOf(examId, label));
        transaction.oncomplete = () => {
            db.close();
            resolve();
        };
        transaction.onerror = () => {
            db.close();
            reject(transaction.error);
        };
    });
}

function isDraft(value: unknown): value is DraftState {
    if (typeof value !== "object" || value === null) return false;
    const v = value as Record<string, unknown>; // tigerlint-allow: no-as-cast -- the shape is checked field by field just below
    return (
        typeof v["seq"] === "number" &&
        typeof v["ackedSeq"] === "number" &&
        typeof v["content"] === "string" &&
        typeof v["language"] === "string" &&
        typeof v["over"] === "boolean"
    );
}
