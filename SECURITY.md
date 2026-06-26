# Security Policy

LibreDB is a database: reliability and integrity are not negotiable. We take security reports
seriously and appreciate responsible disclosure.

## Supported versions

LibreDB is pre-1.0 and under active development. Security fixes are applied to the latest released
version on npm (`@libredb/libredb`). Older `0.x` versions are not maintained — please upgrade to the
latest release before reporting.

| Version | Supported |
| ------- | --------- |
| latest `0.x` | Yes |
| older `0.x`  | No  |

## Reporting a vulnerability

**Do not open a public issue for a security vulnerability.**

Please report privately through one of these channels:

1. **GitHub Security Advisories (preferred).** Use the repository's
   *Security -> Report a vulnerability* tab to open a private advisory. This keeps the report
   confidential while we work on a fix.
2. **Email.** If you cannot use GitHub advisories, email **cevheribozoglan@gmail.com** with the
   details.

Please include, as far as you can:

- A description of the vulnerability and its impact.
- Steps to reproduce, or a minimal proof of concept.
- The affected version and environment (Bun/Node version, OS).
- Any suggested remediation, if you have one.

## What to expect

- **Acknowledgement** of your report within a few days.
- An assessment and, if confirmed, a fix tracked privately until a release is ready.
- Coordinated disclosure: we will agree with you on timing before any public detail is shared, and we
  are happy to credit you in the advisory unless you prefer to remain anonymous.

Thank you for helping keep LibreDB and its users safe.
