# Campaign Management System — Backend

A production-grade, distributed backend for contact management and bulk campaign delivery, designed to handle **millions of contacts and messages** without degrading performance.

---

## Table of Contents

1. [System Architecture](#system-architecture)
2. [Database Design](#database-design)
3. [API Reference](#api-reference)
4. [Worker Pipeline](#worker-pipeline)
5. [Scalability Strategies](#scalability-strategies)
6. [Setup & Installation](#setup--installation)
7. [Design Decisions & Trade-offs](#design-decisions--trade-offs)
8. [Monitoring & Observability](#monitoring--observability)

---

## System Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                          CLIENT (Next.js)                            │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ HTTPS
                                ▼
┌──────────────────────────────────────────────────────────────────────┐
│                     Express API Server (Port 3000)                    │
│  ┌──────────────┐  ┌────────────────────┐  ┌──────────────────────┐  │
│  │   /contacts  │  │    /campaigns      │  │   Rate Limiter       │  │
│  │  Controller  │  │    Controller      │  │   (Redis + express-  │  │
│  └──────┬───────┘  └────────┬───────────┘  │    rate-limit)       │  │
│         │                  │               └──────────────────────┘  │
└─────────┼──────────────────┼───────────────────────────────────────-─┘
          │  enqueue job     │  enqueue job
          ▼                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        RabbitMQ (Port 5673)                          │
│  ┌──────────────────┐  ┌────────────────────┐  ┌─────────────────┐  │
│  │  csv.processing  │  │ campaign.execution │  │ msg.delivery    │  │
│  │  (durable queue) │  │  (durable queue)   │  │ (durable queue) │  │
│  └────────┬─────────┘  └─────────┬──────────┘  └────────┬────────┘  │
└───────────┼────────────────────--┼─────────────────────-─┼───────────┘
            ▼                      ▼                        ▼
┌───────────────────┐  ┌───────────────────────┐  ┌────────────────────┐
│  CSV Processing   │  │  Campaign Execution   │  │  Message Delivery  │
│     Worker        │  │      Worker           │  │     Worker(s)      │
│  (streams CSV     │  │  (streams contacts    │  │  (simulates send,  │
│   from Cloudinary)│  │   via DB cursor)      │  │   updates status)  │
└────────┬──────────┘  └──────────┬────────────┘  └────────────────────┘
         │ bulk insert            │ insert messages       │ updateMany
         ▼                        ▼                        ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         MongoDB Atlas                                │
│         contacts (1M+)  │  campaigns  │  messages (10M+)            │
└─────────────────────────────────────────────────────────────────────┘
         ▲
         │ rate-limit counters
┌────────┴──────────┐
│   Redis (Port 6377) │
└───────────────────┘
```

### Component Responsibilities

| Component | Role | Scales by |
|---|---|---|
| **Express API** | Validates requests, enqueues jobs, returns immediate 202 responses | Horizontal (multiple instances behind load balancer) |
| **RabbitMQ** | Durable job queue, survives restarts | Clustering / mirrored queues |
| **CSV Worker** | Streams CSV → parses → batches contacts | Multiple concurrent consumers on same queue |
| **Campaign Execution Worker** | Streams audience from DB, creates Message docs in bulk | Multiple concurrent consumers |
| **Message Delivery Worker** | Simulates/sends messages, updates status | Scale out to N workers; each takes prefetch=1 |
| **MongoDB** | Persistent data store with compound indexes | Replica set → Sharding for 10 M+ records |
| **Redis** | Rate limit counters, optional job-status cache | Redis Cluster for HA |

---

## Database Design

### Collections Overview

```
contacts    — stores all contacts (1M+ target)
campaigns   — stores campaign metadata
messages    — stores per-contact delivery records (can reach 10M+)
```

### Schema: `contacts`

```javascript
{
  _id:       ObjectId,          // auto-generated primary key
  name:      String,            // optional display name
  email:     String,            // sparse unique — allows null
  phone:     String,            // required, unique (primary dedup key)
  tags:      [String],          // multikey array for audience segmentation
  metadata:  Mixed,             // arbitrary CSV columns preserved as key-value
  createdAt: Date,              // auto (timestamps: true)
  updatedAt: Date               // auto (timestamps: true)
}
```

**Indexes on `contacts`:**

```
phone_1             — unique, prevents duplicate phone numbers
email_1             — unique + sparse, allows null emails
createdAt_-1__id_-1 — compound, cursor pagination (desc)
createdAt_1__id_1   — compound, cursor pagination (asc)
tags_1              — multikey, fast audience tag filtering
Atlas Search (default) — Lucene-based fuzzy search on name, email, phone, and tags
```

**Why sparse on email?**
CSV files commonly omit the email column. A standard unique index would reject all null-email rows as duplicates. `sparse: true` makes MongoDB skip null values from the index entirely.

---

### Schema: `campaigns`

```javascript
{
  _id:            ObjectId,
  name:           String,         // required — campaign display name
  template:       String,         // required — message template text
  audienceFilter: Mixed,          // stored query filter for audience
  status:         String,         // enum: Draft | Running | Completed | Failed
  totalContacts:  Number,         // pre-computed — set at campaign start
  sentCount:      Number,         // pre-computed — incremented by delivery worker
  failedCount:    Number,         // pre-computed — incremented by delivery worker
  pendingCount:   Number,         // pre-computed — decremented as messages are processed
  createdAt:      Date,
  updatedAt:      Date
}
```

**Indexes on `campaigns`:**

```
createdAt_-1__id_-1  — compound, cursor pagination for campaign list
```

**Why pre-computed counters?**
Polling `Message.countDocuments({ campaignId, status: 'Sent' })` every 2 seconds across 20 active campaigns = 40 expensive aggregation queries/second against the `messages` collection. Pre-computed `$inc` counters on the `campaigns` document reduce dashboard polling to a single O(1) primary-key lookup.

---

### Schema: `messages`

```javascript
{
  _id:        ObjectId,
  campaignId: ObjectId (ref: Campaign),   // required
  contactId:  ObjectId (ref: Contact),    // required
  status:     String,   // enum: Queued | Processing | Sent | Failed
  createdAt:  Date,
  updatedAt:  Date
}
```

**Indexes on `messages`:**

```
campaignId_1_status_1  — compound, per-campaign status breakdown
status_1               — single field, global retry / monitoring queries
```

**Scale note:** With 1 M contacts × 10 campaigns = 10 M message documents. The compound index ensures per-campaign queries are O(log N) regardless of total collection size.

---

### Entity Relationship

```
contacts (1) ──────< messages (M) >────── campaigns (1)
    │                                           │
    │  tags: [String]                           │  audienceFilter: Mixed
    │  (multikey index)                         │  (saved query applied at start)
    └──────────────────────────────────────────┘
```

---

## API Reference

### Base URL
```
http://localhost:3000/api
```

All responses follow the envelope format:
```json
{ "message": "...", "data": { ... } | null }
```

---

### Contacts API

#### `POST /contacts/upload`
Queue a CSV file for bulk import.

**Request body:**
```json
{ "csvUrl": "https://res.cloudinary.com/.../contacts.csv" }
```

**Response `202 Accepted`:**
```json
{ "message": "CSV upload queued successfully", "data": { "jobId": "uuid-v4" } }
```

**How it handles millions of rows:**
- Returns immediately — no blocking.
- CSV is streamed (not downloaded into memory) by the `csvProcessingWorker`.
- Parsed in configurable batches (default 500 rows).
- `insertMany({ ordered: false })` skips duplicates atomically via unique indexes.
- Duplicate rows generate `writeErrors` entries, not failures.

| Behavior | Detail |
|---|---|
| Duplicate phone | Silently skipped (unique index violation) |
| Duplicate email | Silently skipped (sparse unique index violation) |
| Missing email | Allowed (sparse index) |
| Extra CSV columns | Stored in `metadata` field |
| Max file size | Limited by Cloudinary upload, not this API |

---

#### `GET /contacts`
Retrieve a paginated, filterable list of contacts.

**Query parameters:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `cursor` | string | — | Base64-encoded cursor from previous response |
| `limit` | number | 20 | Page size (max recommended: 100) |
| `search` | string | — | Partial & fuzzy search via Atlas Autocomplete (min 2 chars) |
| `tags` | string | — | Comma-separated tags, e.g. `VIP,Premium` |
| `sort` | string | `desc` | `asc` or `desc` by `createdAt` |

**Response `200 OK`:**
```json
{
  "message": "Contacts retrieved successfully",
  "data": {
    "contacts": [ { "_id": "...", "name": "...", "phone": "...", "tags": [] } ],
    "nextCursor": "eyJjcmVhdGVkQXQiOi4uLn0="
  }
}
```

**Pagination internals:**
- Cursor is a base64-encoded JSON: `{ "createdAt": "ISO-8601", "_id": "ObjectId" }`.
- Uses `$lt` / `$gt` comparison — **O(1) cost regardless of page depth**.
- No `skip()` is ever used; page 50,000 is as fast as page 1.

---

### Campaigns API

#### `POST /campaigns`
Create a new campaign in `Draft` state.

**Request body:**
```json
{
  "name": "Summer Sale",
  "template": "Hi {{name}}, check out our summer deals!",
  "audienceFilter": {}
}
```

**Response `201 Created`:**
```json
{ "message": "Campaign created successfully", "data": { "campaignId": "..." } }
```

---

#### `POST /campaigns/:id/start`
Start a campaign — transitions state from `Draft`/`Failed` → `Running`.

**Request body:**

| Field | Type | Description |
|---|---|---|
| `all_selected` | boolean | Target all contacts |
| `tags` | string[] | Target contacts with any of these tags |
| `contactId` | string | Target a single contact |
| `created_after` | ISO date | Target contacts created after this date |
| `created_before` | ISO date | Target contacts created before this date |

**Response `200 OK`:**
```json
{ "message": "Campaign started successfully", "data": null }
```

**Atomicity guarantee:**
Uses `findOneAndUpdate` with a status pre-condition: `{ status: { $in: ['Draft', 'Failed'] } }`. If two requests race to start the same campaign, only the first succeeds — the second receives a `400` because the document no longer matches `Draft`/`Failed`.

---

#### `GET /campaigns`
Paginated campaign list.

**Query parameters:** `cursor`, `limit` (same as contacts)

**Response `200 OK`:**
```json
{
  "data": {
    "campaigns": [ { "_id": "...", "name": "...", "status": "Running" } ],
    "nextCursor": "...",
    "limit": 20
  }
}
```

---

#### `GET /campaigns/:id`
Get live delivery progress for a campaign.

**Response `200 OK`:**
```json
{
  "data": {
    "campaignId": "...",
    "name": "Summer Sale",
    "status": "Running",
    "totalMessages": 50000,
    "sentCount": 32100,
    "failedCount": 450,
    "pendingCount": 17450
  }
}
```

> Dashboard polls this endpoint every ~2 seconds. Since counters are pre-computed via `$inc`, this is a single `_id` primary key lookup — extremely cheap even with dozens of concurrent poller clients.

---

## Worker Pipeline

```
CSV Upload API
     │
     ▼
[csv.processing queue]
     │
     ▼
csvProcessingWorker
  • Downloads CSV stream from Cloudinary URL
  • Parses with csv-parser (streaming, line-by-line)
  • Batches rows (500/batch)
  • Publishes each batch to [contact.creation queue]
     │
     ▼
[contact.creation queue]
     │
     ▼
contactCreationWorker
  • Receives batch JSON
  • Calls insertMany({ ordered: false })
  • Logs inserted vs duplicate counts
  • Acks message when done
```

```
Start Campaign API
     │
     ▼
[campaign.execution queue]
     │
     ▼
campaignExecutionWorker
  • Loads campaign + audienceFilter from DB
  • Opens DB cursor: Contact.find(filter).cursor()
  • Streams contacts (never loads all into memory)
  • Creates Message docs in bulk (500/batch)
  • Updates campaign.totalContacts
  • Publishes message IDs to [msg.delivery queue]
     │
     ▼
[msg.delivery queue]
     │
     ▼
messageDeliveryWorker (can run N instances)
  • Receives batch of message IDs
  • Simulates delivery (configurable delay + failure rate)
  • Message.updateMany(_id $in [...], status: Sent/Failed)
  • Campaign $inc sentCount/failedCount/pendingCount
  • Acks RabbitMQ message
```

### Worker Configuration

| Constant | Default | Description |
|---|---|---|
| `BATCH_SIZES.CSV_PARSING` | 500 | Rows parsed per RabbitMQ message |
| `BATCH_SIZES.CONTACT_CREATION` | 500 | Docs per `insertMany` call |
| `BATCH_SIZES.MESSAGE_CREATION` | 500 | Messages created per iteration |
| `BATCH_SIZES.MESSAGE_DELIVERY` | 50 | Messages delivered per worker batch |
| `PREFETCH_COUNT` | 1 | RabbitMQ prefetch — ensures fair dispatch |

---

## Scalability Strategies

### Handling 1 Million Contacts

| Challenge | Strategy |
|---|---|
| Listing without offset | Cursor-based pagination — O(1) per page |
| Bulk import deduplication | Unique indexes + `ordered: false` |
| Tag-based audience query | Multikey index on `tags` |
| Search across 3 fields | **Atlas Search (Lucene)** — sub-second fuzzy matching at scale |
| Memory-safe audience streaming | MongoDB `.cursor()` — heap stays ~50 MB constant |

### Handling 10 Million Messages

| Challenge | Strategy |
|---|---|
| Per-campaign progress queries | Compound index `campaignId_1_status_1` |
| Dashboard polling load | Pre-computed counters via `$inc` — no aggregation |
| Bulk delivery updates | `updateMany` with `_id` primary key array |
| Parallel delivery workers | Stateless workers; RabbitMQ distributes load evenly |
| Long-term storage growth | Future: TTL index to archive old messages |

### Horizontal Scaling Path

```
Phase 1 (current):   Single API instance + single worker processes
Phase 2 (> 500k req/day): Multiple API instances behind Nginx/ALB
Phase 3 (> 5M contacts):  MongoDB Replica Set (1 primary + 2 secondaries)
Phase 4 (> 50M contacts): MongoDB Sharding on contacts._id (hashed)
Phase 5 (> 100M messages): Shard messages on campaignId; archive old data
```

### Rate Limiting

```
POST /contacts/upload  →  5 requests / 15 minutes per IP
POST /campaigns/start  →  10 requests / minute per IP
GET  endpoints         →  100 requests / minute per IP
```

Counters stored in Redis — consistent across all API instances. Redis failure falls back to allow-all (configurable).

---

## Setup & Installation

### Prerequisites

- Node.js ≥ 18
- Docker & Docker Compose (for RabbitMQ + Redis)
- MongoDB Atlas cluster or local MongoDB ≥ 6.0

### 1. Start infrastructure

```bash
docker-compose up -d
```

This starts:
- **RabbitMQ** on port `5673` (AMQP) + **Management UI** on `http://localhost:15673`
- **Redis** on port `6377` + **Management UI** (Redis Commander) on `http://localhost:8081`

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment

```env
PORT=3000
MONGO_URI=mongodb://localhost:27017/campaign-management-system
REDIS_URL=redis://localhost:6377
RABBITMQ_URL=amqp://guest:guest@localhost:5673
```

### 4. Start the server

```bash
npm run start        # production
npx nodemon src/server.js  # development (auto-reload)
```

### 5. Verify indexes exist

```bash
# In mongosh
db.contacts.getIndexes()
db.campaigns.getIndexes()
db.messages.getIndexes()
```

---

## Design Decisions & Trade-offs

### 1. RabbitMQ for Async Job Processing

| ✅ Benefit | ⚠️ Trade-off |
|---|---|
| API responds in < 10ms regardless of job size | Requires running RabbitMQ instance |
| Jobs survive API restarts (durable queues) | Adds operational complexity |
| N workers can process in parallel | Message ordering not guaranteed (acceptable here) |

### 2. Cursor-Based Pagination over Offset

| ✅ Benefit | ⚠️ Trade-off |
|---|---|
| O(1) per page — page 50,000 = page 1 | Cannot jump to arbitrary page number |
| No "phantom records" on concurrent inserts | Client must store and pass cursor token |
| Index-aligned — no in-memory sort | Sorting options must match index fields |

### 3. Pre-Computed Campaign Counters

| ✅ Benefit | ⚠️ Trade-off |
|---|---|
| Dashboard polling = single _id lookup | Counter can drift if worker crashes mid-update |
| No aggregation under polling load | Requires `$inc` discipline in all workers |
| Works at 10 M+ messages without degradation | Must reconcile on campaign `Completed` transition |

### 4. `insertMany({ ordered: false })` for Bulk Import

| ✅ Benefit | ⚠️ Trade-off |
|---|---|
| Skips duplicates without stopping batch | Cannot guarantee insertion order |
| Parallel index checks by MongoDB | `writeErrors` must be parsed for duplicate count |
| 5,000–10,000 rows/sec throughput | Large batches risk Node.js OOM (keep ≤ 1,000) |

### 5. MongoDB Cursor Streaming for Campaign Audience

| ✅ Benefit | ⚠️ Trade-off |
|---|---|
| Heap stays ~50 MB even for 1 M contacts | Cursor can time out on very slow processing |
| No need for pagination logic in worker | Requires `allowDiskUse` if sort is needed |
| Backpressure handled by async iteration | Must explicitly close cursor on error |

### 6. Atomic `findOneAndUpdate` for Campaign State

| ✅ Benefit | ⚠️ Trade-off |
|---|---|
| Prevents double-start race condition | Slightly more verbose than `findById` + `save` |
| Single round-trip to DB | Less flexible if complex pre-conditions are needed |
| Returns updated document in one query | — |

---

## Monitoring & Observability

| Service | URL | Notes |
|---|---|---|
| **Swagger API Docs** | http://localhost:3000/api-docs | Full API reference with request/response schemas |
| **RabbitMQ Management** | http://localhost:15673 | Queue depth, message rates, consumer count (guest/guest) |
| **Redis Management** | http://localhost:8081 | Redis Commander UI to inspect keys and rate limits |
| **MongoDB Atlas** | Atlas dashboard | Query performance advisor, index suggestions |

### Key Metrics to Monitor in Production

| Metric | Alert threshold | Action |
|---|---|---|
| RabbitMQ `csv.processing` queue depth | > 10 | Scale up CSV worker instances |
| RabbitMQ `msg.delivery` queue depth | > 50,000 | Scale up delivery worker instances |
| MongoDB `totalDocsExamined / nReturned` | > 100x | A query is missing an index |
| MongoDB `repl lag` | > 10s | Investigate secondary node performance |
| Redis memory | > 80% | Increase Redis max memory or evict keys |
| Node.js heap | > 1.5 GB | Check for cursor leaks or large result sets |

---

## Query Performance Reference

See [query_analysis.md](./query_analysis.md) for detailed per-query index usage, `executionStats` plan diagrams, and scalability thresholds.
