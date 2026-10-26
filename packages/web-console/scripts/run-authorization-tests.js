process.env.HEDGELING_REQUIRE_TEST_DATABASE = "true";

await import("../test/authorization.integration.mjs");
