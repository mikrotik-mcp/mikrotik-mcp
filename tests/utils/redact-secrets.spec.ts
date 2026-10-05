import { describe, expect, test } from "vite-plus/test";
import { redactSecrets } from "../../src/utils/redact-secrets";

describe("redactSecrets", () => {
  test("masks bare, escaped and shorthand Wi-Fi secrets without losing auth evidence", () => {
    const input =
      'security.authentication-types=wpa2-psk,wpa3-psk .passphrase="a\\"b\\\\c\nline" eap-password=bare wpa2-pre-shared-key="secret" nv2-preshared-key=hidden';
    expect(redactSecrets(input)).toBe(
      'security.authentication-types=wpa2-psk,wpa3-psk .passphrase="***" eap-password="***" wpa2-pre-shared-key="***" nv2-preshared-key="***"',
    );
  });

  test("masks bare passwords and legacy static encryption keys", () => {
    expect(redactSecrets('password=bare shared-secret=bare static-key-0=abcdef key0="abcd"')).toBe(
      'password="***" shared-secret="***" static-key-0="***" key0="***"',
    );
  });
  test("masks password values", () => {
    expect(redactSecrets('name="bob" password="hunter2"')).toBe('name="bob" password="***"');
  });

  test("masks secret and shared-secret values", () => {
    expect(redactSecrets('secret="abc"')).toBe('secret="***"');
    expect(redactSecrets('shared-secret="abc"')).toBe('shared-secret="***"');
  });

  test("does not half-mask shared-secret via the inner 'secret' key", () => {
    // The whole key must be matched, not the trailing 'secret'.
    expect(redactSecrets('shared-secret="abc"')).toBe('shared-secret="***"');
    expect(redactSecrets('shared-secret="abc"')).not.toContain("shared-***");
  });

  test("masks multiple occurrences and multiple keys at once", () => {
    const input = 'password="a" comment="x" shared-secret="b" secret="c"';
    expect(redactSecrets(input)).toBe(
      'password="***" comment="x" shared-secret="***" secret="***"',
    );
  });

  test("leaves non-sensitive keys untouched", () => {
    const input = 'name="wg0" address="10.0.0.1" comment="my password is safe"';
    expect(redactSecrets(input)).toBe(input);
  });

  test("does not match a key that is a suffix of a longer non-sensitive key", () => {
    // e.g. a hypothetical "user-password" should still be masked only as the
    // whole 'password' if preceded by a non-word/dash char; here the dash guards it.
    expect(redactSecrets('my-password="x"')).toBe('my-password="x"');
  });

  test("returns empty/clean text unchanged", () => {
    expect(redactSecrets("")).toBe("");
    expect(redactSecrets("no secrets here")).toBe("no secrets here");
  });
});
