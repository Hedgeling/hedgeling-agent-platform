import assert from "node:assert/strict";
import test from "node:test";
import {
  isIdempotentNpmAbsence,
  npmProvisioningCommands,
} from "../src/npm-provider.js";

const configuration = {
  organization: "hedgeling",
  customerTeam: "hedgeling:customer-readers",
  packageName: "@hedgeling/i18n",
  registry: "https://registry.npmjs.org/",
  token: "secret",
};

test("npm invite adds a developer then the dedicated customer-reader team", () => {
  assert.deepEqual(
    npmProvisioningCommands("invite", "annie", configuration),
    [
      ["org", "set", "hedgeling", "annie", "developer"],
      ["team", "add", "hedgeling:customer-readers", "annie"],
    ],
  );
});

test("npm revocation removes both dedicated-team and organization membership", () => {
  assert.deepEqual(
    npmProvisioningCommands("revoke", "annie", configuration),
    [
      ["team", "rm", "hedgeling:customer-readers", "annie"],
      ["org", "rm", "hedgeling", "annie"],
    ],
  );
});

test("npm revocation retries tolerate only explicit already-absent membership", () => {
  assert.equal(
    isIdempotentNpmAbsence("revoke", {
      stderr: "npm error user is not a member of this team",
    }),
    true,
  );
  assert.equal(
    isIdempotentNpmAbsence("revoke", {
      stderr: "npm error authentication token expired",
    }),
    false,
  );
  assert.equal(
    isIdempotentNpmAbsence("invite", {
      stderr: "npm error user is not a member of this team",
    }),
    false,
  );
});
