---
title: "Certificates"
description: "X.509 certificate management (`/certificate`)."
---

## Tools

- [List Certificates](#list_certificates)
- [Get Certificate Details](#get_certificate)
- [Create Certificate Template](#create_certificate)
- [Sign Certificate](#sign_certificate)
- [Remove Certificate](#remove_certificate)
- [Import Certificate from File](#import_certificate)

## list_certificates

**List Certificates** · Risk: **read**

Lists certificates from the device certificate store (`/certificate`). Use to browse all installed certificates — CA, TLS server, client, and self-signed — along with their validity, fingerprint, and key-usage flags. Returns all entries or those matching an optional partial `name_filter` on the certificate name. For full detail on a single certificate use `get_certificate`.

| Parameter     | Required | Definition                             |
| ------------- | -------- | -------------------------------------- |
| `name_filter` | No       | Partial name match `{"type":"string"}` |

## get_certificate

**Get Certificate Details** · Risk: **read**

Retrieves full detail for a single named certificate (`/certificate print detail where name=...`). Use to inspect a certificate's subject, issuer, expiry date, fingerprint, key-usage flags, and trust status. Takes the certificate `name` as a string — use `list_certificates` to find available names. For bulk browsing of all certificates use `list_certificates`.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## create_certificate

**Create Certificate Template** · Risk: **write**

Creates an unsigned certificate template in the device store (`/certificate add`). Use as the first step in generating a local PKI certificate — sets subject fields (common-name, country, organization), RSA key size, validity period in days, and key-usage flags (e.g. 'tls-server', 'key-cert-sign'). The resulting certificate is NOT yet signed; call `sign_certificate` next to self-sign it or sign it with a named CA certificate. To register an externally generated cert/key file already on the device filesystem use `import_certificate`. Returns the created certificate's full detail including its name.

| Parameter          | Required | Definition                                                                                                        |
| ------------------ | -------- | ----------------------------------------------------------------------------------------------------------------- |
| `name`             | Yes      | Name for the certificate `{"type":"string"}`                                                                      |
| `common_name`      | Yes      | Common name (CN), e.g. a hostname or domain `{"type":"string"}`                                                   |
| `key_size`         | Yes      | RSA key size in bits `{"default":2048,"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`   |
| `days_valid`       | Yes      | Validity period in days `{"default":365,"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |
| `key_usage`        | No       | Comma-separated key usages, e.g. 'tls-server' `{"type":"string"}`                                                 |
| `country`          | No       | Country code (C), e.g. 'US' `{"type":"string"}`                                                                   |
| `state`            | No       | State or province (ST) `{"type":"string"}`                                                                        |
| `locality`         | No       | Locality / city (L) `{"type":"string"}`                                                                           |
| `organization`     | No       | Organization (O) `{"type":"string"}`                                                                              |
| `unit`             | No       | Organizational unit (OU) `{"type":"string"}`                                                                      |
| `subject_alt_name` | No       | Subject Alternative Name(s), e.g. 'DNS:example.com,IP:1.2.3.4' `{"type":"string"}`                                |
| `trusted`          | No       | Whether the certificate is trusted for chain verification `{"type":"boolean"}`                                    |

## sign_certificate

**Sign Certificate** · Risk: **write**

Signs an existing certificate template (`/certificate sign`) to produce a valid certificate. Omit `ca` to produce a self-signed certificate; supply the name of an existing CA certificate in `ca` to issue it under that CA. IMPORTANT: certificate stores are PER-DEVICE — the template (and the `ca`, if given) must live on the SAME router this runs on. A 'CA not found' error almost always means the template or CA was created on a different device; verify with list_certificates on this device first (and check the targeting). Set the common name (CN) when you create the template (create_certificate), not here — `/certificate sign` has no CN option. May run for several seconds while the device generates key material. Returns the signing operation output from the device.

| Parameter | Required | Definition                                                                                                 |
| --------- | -------- | ---------------------------------------------------------------------------------------------------------- |
| `name`    | Yes      | Name of the certificate template to sign `{"type":"string"}`                                               |
| `ca`      | No       | Name of the CA certificate to sign with (must exist on THIS device; omit to self-sign) `{"type":"string"}` |

## remove_certificate

**Remove Certificate** · Risk: **destructive**

Permanently deletes a named certificate from the device store (`/certificate remove [find name=...]`). Performs an existence check first and returns an error if the certificate is not found. Removing a CA certificate will invalidate any leaf certificates it signed. Use `list_certificates` to browse certificate names before removal.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## import_certificate

**Import Certificate from File** · Risk: **write**

Imports a certificate or private key from a file already present on the device filesystem (`/certificate import`). Use when you have uploaded a PEM, DER, or PKCS12 file to the device via FTP/SCP/Winbox and need to register it in the certificate store. Supply `passphrase` if the key is encrypted, and `name` to label the imported entry in the store. To generate a certificate locally on the device instead use `create_certificate` followed by `sign_certificate`.

| Parameter    | Required | Definition                                                         |
| ------------ | -------- | ------------------------------------------------------------------ |
| `file_name`  | Yes      | Name of the certificate/key file to import `{"type":"string"}`     |
| `passphrase` | No       | Passphrase protecting the imported key, if any `{"type":"string"}` |
| `name`       | No       | Name to assign to the imported certificate `{"type":"string"}`     |
