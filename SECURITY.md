# Security policy

## Supported version

Security fixes are applied to the latest published OmniShell release.

## Reporting a vulnerability

Please do not open a public issue for a vulnerability, exposed credential, or unsafe installer behavior. Use GitHub's private vulnerability reporting feature on the repository's **Security** tab.

Include:

- the affected OmniShell version;
- the affected CLI or installer;
- reproduction steps;
- the expected security boundary;
- logs with credentials, account identifiers, and private paths removed.

OmniShell isolates profile directories but is not an operating-system sandbox. Launched tools retain the permissions of the Windows account running OmniShell.
