// Goal: the loose bodies identity providers send are read correctly and nothing else is believed: Okta and Azure forms of "switch
// off", only the one filter we support, and a person shown without anything we do not hold.
import { describe, expect, it } from "vitest";
import { activeFrom, emailFromFilter, parseCreate, toResource } from "./scim.ts";

describe("activeFrom", () => {
    it("reads Okta's and Azure's forms", () => {
        expect(activeFrom({ Operations: [{ op: "replace", value: { active: false } }] })).toBe(
            false,
        );
        expect(
            activeFrom({ Operations: [{ op: "Replace", path: "active", value: "False" }] }),
        ).toBe(false);
        expect(activeFrom({ Operations: [{ op: "replace", path: "active", value: true }] })).toBe(
            true,
        );
        expect(activeFrom({ active: false })).toBe(false);
    });
    it("says nothing for anything else", () => {
        for (const body of [
            null,
            {},
            { Operations: [] },
            { Operations: [{ op: "replace", path: "displayName", value: "x" }] },
            { Operations: [{ op: "remove", path: "active" }] },
            { active: "maybe" },
        ])
            expect(activeFrom(body), JSON.stringify(body)).toBeNull();
    });
});

describe("parseCreate", () => {
    it("takes an email address as the user name, lowercased, and defaults to active", () => {
        expect(
            parseCreate({
                userName: "Ada@Acme.Example",
                externalId: "x1",
                name: { givenName: "Ada" },
            }),
        ).toEqual({ email: "ada@acme.example", externalId: "x1", active: true });
        expect(parseCreate({ userName: "a@acme.example", active: "False" })?.active).toBe(false);
    });
    it("refuses what is not an address", () => {
        for (const body of [
            null,
            {},
            { userName: "ada" },
            { userName: 5 },
            { userName: "a@b.example", externalId: "" },
        ])
            expect(parseCreate(body), JSON.stringify(body)).toBeNull();
    });
});

describe("emailFromFilter", () => {
    it("understands userName eq only", () => {
        expect(emailFromFilter(undefined)).toEqual({ ok: true, email: null });
        expect(emailFromFilter('userName eq "Ada@Acme.example"')).toEqual({
            ok: true,
            email: "ada@acme.example",
        });
        for (const f of [
            'userName co "a"',
            'userName eq "a" or userName eq "b"',
            'emails.value eq "a"',
            'userName eq "a\\"b"',
        ])
            expect(emailFromFilter(f), f).toEqual({ ok: false });
    });
});

describe("toResource", () => {
    it("shows the SCIM user and no more", () => {
        const at = new Date(Date.UTC(2026, 9, 15));
        const resource = toResource({
            user_id: "u1",
            email: "a@acme.example",
            external_id: null,
            active: true,
            created_at: at,
            updated_at: at,
        });
        expect(resource).toMatchObject({
            id: "u1",
            userName: "a@acme.example",
            active: true,
            emails: [{ value: "a@acme.example", primary: true }],
        });
        expect("externalId" in resource).toBe(false);
    });
});
