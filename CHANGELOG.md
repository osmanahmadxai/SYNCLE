# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and the project aims
to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-08-20

First stable release: visual bridges between any supported engines
(PostgreSQL, MySQL/MariaDB, SQLite, MongoDB, Redis) and HTTP endpoints, fired
by one-shot replay, cursor polling, or change-data-capture — with idempotent
multi-target delivery, a live timeline, and the database workbench.

### Added

- Database-to-database bridges: sync data across engines directly, with HTTP
  endpoints as an extra destination rather than the only one.
- Workspaces, with hooks reframed as bridges and a live workspace map.
- Event-based (CDC) delivery for **MySQL** (binlog), **MongoDB** (change
  streams), and **Redis** (keyspace notifications), alongside the existing
  PostgreSQL logical-replication support. Each engine sits behind a shared
  `CdcProvider` interface.
- A login system and a settings section.
- One-command Docker install (`install.sh`) and the `syncle` launcher CLI.
- Chinese (zh) localization for the web app.
- The `{{$op}}` payload token, exposing the change operation
  (`insert` / `update` / `delete`) for CDC and watch hooks.
- README visuals: animated banner, badges, diagrams, and a how-to guide.

### Changed

- Renamed the project to **Syncle** (formerly Data Bridge).
- The internal metadata store now runs on **PostgreSQL** instead of SQLite.
- The live delivery monitor fetches one final time when a run finishes, so the
  last cells settle correctly; added a LIVE indicator and auto-follow paging.

### Fixed

- Crash, data-loss, and injection paths across the API layer, bridge engine,
  and core adapters; multi-target bridge writes are atomic and backup memory
  is bounded.
- Stale-state bugs in the studio, which now updates instantly.
- Delivery timeline now uses the run's snapshot `batchSize`, keeping cells
  aligned even after a hook is edited mid-run.
