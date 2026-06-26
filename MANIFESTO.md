# LibreDB Manifesto

> Status: draft v0.2 — working document, not yet ratified.

**LibreDB was born against the unnecessary complexity of the database world.**

Data should not hide behind black boxes, heavy frameworks, opaque cloud panels, and unreadable abstraction layers. A database can be powerful and still remain understandable. We believe this — and we believe most modern tools have forgotten it.

## What we are against

A developer should not have to learn a giant ORM, a migration system, an admin panel, and a vendor ecosystem just to manage their own data. We are not at war with ORMs — we are against the database experience that *forces* you into one.

## What we are building

Our goal is not to be the biggest database that does everything. Our goal is to build a small but serious core: **readable, embeddable, hackable, and reliable.**

We write a single small storage core. Relational, document, and key-value are thin *lenses* on top of it — not three separate engines. Our strength comes not from what we add, but from what we deliberately refuse.

## Open the source, and you learn how a database works

LibreDB is small enough to read in one sitting. We do not compress code to look clever; we open it up to make it clear. Whoever opens the core sees the essential idea, understands its logic, and embeds it into their own product in an afternoon. Readability is not marketing for us — it is a design constraint.

## Nothing is hidden

The query is visible.
The schema is visible.
Errors are not hidden.
Plans are explained.
No unnecessary veil is placed between data and developer.

## Reliability is not negotiable

Readable does not mean toy. We are trustworthy not because we are small, but because we test every line. We start in test and development environments today — but that is a beginning, not a ceiling. We earn trust through tests, not line counts; and we earn our way into production.

## Open at the edges, guarded at the core

Drivers, adapters, the query surface, the studio, and the docs are open to everyone — to read, to fork, to contribute fast. The durability core — storage, transactions, recovery — is open for everyone to read; but every line written into it passes heavy review and deterministic testing, so it stays worthy of the data it holds.

## One core, three faces

LibreDB Database is the plain core of data.
LibreDB Studio is the understandable face of data.
LibreDB Platform is the manageable form of data for teams.
All three speak the same spine, the same language.

## Our claim

A database can be readable again.
A database can be learnable again.
A database can be hackable again.
A database can be close enough for a developer to understand again.

*LibreDB gives the database back to the developer.*
