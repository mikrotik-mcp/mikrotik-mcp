---
title: "Certificate Steward"
description: "Certificate lifecycle helpers: a one-call expiry audit and Let's Encrypt issuance/renewal via RouterOS's ACME client — so a TLS cert never silently lapses."
---

## Tools

- [Audit Certificate Expiry](#audit_certificate_expiry)
- [Request/Renew Let's Encrypt Certificate](#request_letsencrypt_certificate)

## audit_certificate_expiry

**Audit Certificate Expiry** · Risk: **read**

Scans every certificate in the device store (`/certificate print detail`) and reports how long until each one expires — sorted by urgency, with anything ALREADY EXPIRED or expiring within `warn_within_days` (default 30) flagged first. Use this to catch a TLS cert (SSTP, API-SSL, hotspot, REST/www-ssl) before it lapses and silently breaks a service. For the full detail of one certificate use get_certificate; to obtain/renew a Let's Encrypt cert use request_letsencrypt_certificate. Returns a grouped report (expired · expiring soon · ok), plus any certs with no parseable expiry (e.g. unsigned templates).

| Parameter          | Required | Definition                                                                                                                                                   |
| ------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `warn_within_days` | Yes      | Flag certificates expiring within this many days as 'expiring soon' `{"default":30,"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |

## request_letsencrypt_certificate

**Request/Renew Let's Encrypt Certificate** · Risk: **write**

Obtains (or renews) a free Let's Encrypt TLS certificate for `dns_name` using RouterOS's built-in ACME client (`/certificate enable-ssl-certificate`). The device must be reachable from the internet on TCP 80 and `dns_name` must already resolve to it (ACME http-01 challenge). On success the certificate is installed in the store and bound to the www-ssl service; re-running this for the same name renews it. To check what is installed and when it expires use audit_certificate_expiry. NOTE: this reaches the public ACME service and may take several seconds. Returns the device's output from the request.

| Parameter  | Required | Definition                                                                               |
| ---------- | -------- | ---------------------------------------------------------------------------------------- |
| `dns_name` | Yes      | Public DNS name that resolves to this router, e.g. 'vpn.example.com' `{"type":"string"}` |
