import assert from "node:assert/strict";
import test from "node:test";
import {
  RESERVED_APP_ROUTES,
  RESERVED_USERNAMES,
  isReservedUsername,
} from "../utils/reservedUsernames.js";
import { RESERVED_PATHS } from "../../frontend/src/lib/profileLink.js";

test("reserved route names: frontend RESERVED_PATHS and backend RESERVED_APP_ROUTES are 100% synchronized with zero drift", () => {
  const frontendPaths = Array.from(RESERVED_PATHS).sort();
  const backendRoutes = Array.from(RESERVED_APP_ROUTES).sort();

  assert.deepEqual(
    frontendPaths,
    backendRoutes,
    "Frontend RESERVED_PATHS and Backend RESERVED_APP_ROUTES must match exactly"
  );

  // Assert every single frontend path is also recognized as reserved by backend isReservedUsername
  for (const path of RESERVED_PATHS) {
    assert.equal(
      isReservedUsername(path),
      true,
      `Path "${path}" must be blocked as a reserved username on the backend`
    );
    assert.equal(
      RESERVED_USERNAMES.has(path),
      true,
      `Path "${path}" must exist in RESERVED_USERNAMES`
    );
  }
});

test("impersonation patterns and platform names are blocked", () => {
  assert.equal(isReservedUsername("gossips_support"), true);
  assert.equal(isReservedUsername("gossips-help"), true);
  assert.equal(isReservedUsername("official_support"), true);
  assert.equal(isReservedUsername("support-gossips"), true);
  assert.equal(isReservedUsername("admin"), true);
  assert.equal(isReservedUsername("superuser"), true);

  // Real regular usernames are allowed
  assert.equal(isReservedUsername("gossipsfan"), false);
  assert.equal(isReservedUsername("gossipsgirl"), false);
  assert.equal(isReservedUsername("john_doe"), false);
});
