import test from "node:test";
import assert from "node:assert/strict";
import { formatPhoneNumberForCountry } from "./company-create-form";

test("formats phone numbers for US and IN country codes", () => {
  assert.equal(formatPhoneNumberForCountry("9876543210", "US"), "+19876543210");
  assert.equal(
    formatPhoneNumberForCountry("9876543210", "IN"),
    "+919876543210",
  );
  assert.equal(
    formatPhoneNumberForCountry("+91 9876543210", "IN"),
    "+919876543210",
  );
  assert.equal(formatPhoneNumberForCountry("7123456789", "GB"), "+447123456789");
  assert.equal(formatPhoneNumberForCountry("", "US"), undefined);
});
